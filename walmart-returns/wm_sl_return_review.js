/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * Human review tool for Walmart returns synced by wm_mr_return_import.js.
 * Lists every return still sitting at Pending Inspection, and lets a
 * reviewer record a decision after physically inspecting the returned item.
 *
 *  Handling returns from Walmart:
 *   - "Approval" IS issuing the refund
 *   - There is no seller-callable partial-decline API either -- Walmart
 *     doesn't split a multi-quantity same-SKU return into separate lines
 *     (confirmed against a real sandbox payload: 2 tires returned on one
 *     line, quantity.measurementValue=2, not two lines), so declining part
 *     of a line's quantity has the same real-world consequence as declining
 *     a whole line or a whole return: it has to be disputed by hand in
 *     Seller Center. This tool can only record the decision in NetSuite,
 *     notify the team with the specifics, and hand them a link.
 *
 *  Decisions are per line, by quantity, not one Approve/Reject choice for
 *  the whole return -- each line gets a quantity approved for refund from 0
 *  up to the quantity requested, with a reason required whenever it's less
 *  than the full amount. Quantity approved and reason live on
 *  customrecord_wal_return_line (one child record per Walmart
 *  returnOrderLine, synced by wm_mr_return_import.js), not on the parent
 *  return record.
 *
 *  Routes:
 *   PENDING INSPECTION (GET, no custpage_return_id): queue of every return
 *     waiting on a decision, oldest-synced first. Clicking a row loads that
 *     return's current status and routes to whichever page below applies.
 *   Not yet delivered (GET with custpage_return_id, still Pending Inspection
 *     but no delivery date synced): read-only -- nothing to physically
 *     inspect yet, see buildNotYetDeliveredPage().
 *   PENDING INSPECTION + delivered (GET with custpage_return_id): decision
 *     form -- one block per line with quantity requested (read-only), an
 *     editable quantity approved (0 to the full requested quantity), and a
 *     reason required whenever the quantity approved is less than
 *     requested, plus a mandatory "physically inspected" checkbox (required
 *     whenever any line's quantity approved is > 0). Submitting either:
 *       - every line's quantity approved is 0: this IS the final decision
 *         (no refund call, nothing left to confirm) -- persists it to
 *         customrecord_wal_return_line immediately, writes review status
 *         "Rejected", and sends the shortfall notification email (below).
 *       - at least one line has quantity approved > 0: nothing is persisted
 *         yet -- the decision is carried forward as hidden fields into the
 *         refund-confirm screen below instead of being written to the line
 *         records. Navigating away before confirming loses it; revisiting
 *         this return re-shows a blank decision form, not a pre-filled one.
 *   Refund-confirm screen (reached right after submitting a decision with at
 *     least one line's quantity approved > 0): shows exactly what's about
 *     to be refunded per line, warns this can't be undone from here, and
 *     calls Walmart's refund API on an explicit second submit for only the
 *     approved quantities. Only once that call succeeds does the decision
 *     actually get written to customrecord_wal_return_line and review status
 *     become "Refund Initiated"; if the total approved was less than the
 *     total requested, also sends the shortfall notification email.
 *   Shortfall notification email: sent whenever total quantity approved is
 *     less than total quantity requested (whether that's one short line or
 *     the whole return) -- lists each short line's number/qty/reason and
 *     tells the team to dispute the shortfall in Seller Center within 48
 *     hours.
 *
 * Script parameters:
 *   custscript_wal_return_review_client_id  - Walmart Marketplace API Client ID
 *   custscript_wal_return_review_secret     - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_return_review_env        - "PRODUCTION" or "SANDBOX"
 */
define(
    [
        'N/record', 'N/search', 'N/runtime', 'N/https', 'N/encode', 'N/email',
        'N/ui/serverWidget', 'N/ui/message', 'N/url', 'N/format', 'N/crypto/random', 'N/log'
    ],
    (record, search, runtime, https, encode, email, serverWidget, message, url, format, random, log) => {

        const BASE_URLS = {
            PRODUCTION: 'https://marketplace.walmartapis.com',
            SANDBOX: 'https://sandbox.walmartapis.com'
        };

        const BUTTON_STYLE = 'display:inline-block;padding:10px 20px;background:#187bf2;color:#fff;'
            + 'font-weight:bold;font-size:14px;text-decoration:none;border-radius:3px;border:none;cursor:pointer;';

        const SECONDARY_BUTTON_STYLE = 'display:inline-block;padding:10px 20px;background:#eee;color:#333;'
            + 'font-weight:bold;font-size:14px;text-decoration:none;border-radius:3px;border:1px solid #ccc;cursor:pointer;';

        const MAX_LIST_ROWS = 200;

        const RETURNS_DASHBOARD_URL = 'https://seller.walmart.com/orders/returns';

        const PARAMS = {
            CLIENT_ID: 'custscript_wal_return_review_client_id',
            CLIENT_SECRET: 'custscript_wal_return_review_secret',
            ENVIRONMENT: 'custscript_wal_return_review_env'
        };

        const RETURN_RECORD = {
            TYPE: 'customrecord_wal_returns',
            FIELDS: {
                RETURN_ORDER_ID: 'custrecord_wal_return_order_id',
                PO_ID: 'custrecord_wal_return_po_id',
                RETURN_LINES: 'custrecord_wal_return_lines',
                RETURN_STATUS: 'custrecord_wal_return_status',
                REVIEW_STATUS: 'custrecord_wal_return_review_status',
                TRACKING_NUMBER: 'custrecord_wal_return_tracking_num',
                LABEL_URL: 'custrecord_wal_return_tracking_label_url',
                RAW_JSON: 'custrecord_wal_return_raw_json',
                LAST_SYNCED: 'custrecord_wal_return_last_sync',
                DELIVERY_DATE: 'custrecord_wal_return_delivery_date',
                REVIEW_DATE: 'custrecord_wal_return_review_date',
                REFUND_ISSUED_DATE: 'custrecord_wal_return_refund_issued_date',
                QBO_SYNCED: 'custrecord_wal_return_qbo_synced',
                ERROR: 'custrecord_wal_return_error'
            }
        };

        // Same enum as wm_mr_return_import.js -- keep in sync if it ever changes there.
        const REVIEW_STATUS = {
            PENDING_INSPECTION: 'Pending Inspection',
            REJECTED: 'Rejected',
            REFUND_INITIATED: 'Refund Initiated',
            REFUND_ISSUED: 'Refund Issued',
            REFUNDED_WALMART_INITIATED: 'Refunded (Walmart-Initiated)'
        };

        // Same record/fields as wm_mr_return_import.js's copy -- keep in sync if it ever changes there.
        // QTY_APPROVED/REJECTION_REASON/APPROVED_ITEM_VALUE are this Suitelet's own to set; everything else is sync-owned.
        const RETURN_LINE_RECORD = {
            TYPE: 'customrecord_wal_return_line',
            FIELDS: {
                PARENT: 'custrecord_wal_retline_parent',
                LINE_NUMBER: 'custrecord_wal_retline_number',
                SKU: 'custrecord_wal_retline_sku',
                ITEM_NAME: 'custrecord_wal_retline_item_name',
                QTY_REQUESTED: 'custrecord_wal_retline_qty_requested',
                QTY_APPROVED: 'custrecord_wal_retline_qty_approved',
                REJECTION_REASON: 'custrecord_wal_retline_rejection_reason',
                TOTAL_RETURN_VALUE: 'custrecord_wal_retline_total_value',
                APPROVED_RETURN_VALUE: 'custrecord_wal_retline_approved_value'
            }
        };

        const ACTION = { SUBMIT: 'submit', CONFIRM_REFUND: 'confirm_refund' };

        // TODO: Placeholder author and recipient set to me.
        const RETURN_ALERT_AUTHOR = 126970;
        const RETURN_ALERT_RECIPIENTS = [
            // 12493, // Nick
            // 82292, // Moka Kash
            // 28068, // Camilo Espinosa
            // 13     // Ricky Chavez
            126970 // Me
        ];

        function onRequest(context) {
            const request = context.request;

            try {
                if (request.method !== 'POST') {
                    const returnId = request.parameters.custpage_return_id;
                    if (!returnId) {
                        context.response.writePage(buildListPage());
                        return;
                    }
                    context.response.writePage(buildPageForStatus(returnId));
                    return;
                }

                if (request.parameters.custpage_action === ACTION.SUBMIT) {
                    handleSubmit(context);
                } else if (request.parameters.custpage_action === ACTION.CONFIRM_REFUND) {
                    handleConfirmRefund(context);
                } else {
                    context.response.writePage(buildListPage('Unknown action -- please start again.'));
                }
            } catch (e) {
                log.error('Return review - unhandled error', { errorName: e && e.name, errorMessage: e && e.message });
                context.response.writePage(buildResultPage({ success: false, message: e && e.message }));
            }
        }

        /** Routes a GET on one return to whichever page fits its current review status. */
        function buildPageForStatus(returnId) {
            const lookup = search.lookupFields({
                type: RETURN_RECORD.TYPE, id: returnId,
                columns: [RETURN_RECORD.FIELDS.REVIEW_STATUS, RETURN_RECORD.FIELDS.DELIVERY_DATE]
            });
            const reviewStatus = lookup[RETURN_RECORD.FIELDS.REVIEW_STATUS];
            const deliveryDate = lookup[RETURN_RECORD.FIELDS.DELIVERY_DATE];

            // Guards the decision form itself, not just the queue list -- a direct
            // link to an undelivered return (still Pending Inspection) shouldn't
            // let anyone approve/reject something that hasn't physically arrived.
            if (reviewStatus === REVIEW_STATUS.PENDING_INSPECTION && !deliveryDate) return buildNotYetDeliveredPage(returnId);
            if (reviewStatus === REVIEW_STATUS.PENDING_INSPECTION) return buildReviewPage(returnId);
            return buildAlreadyHandledPage(returnId);
        }

        /** Read-only detail for a return that's Pending Inspection but hasn't reached the return center yet -- nothing to decide on until it arrives. */
        function buildNotYetDeliveredPage(returnId) {
            const returnRecord = record.load({ type: RETURN_RECORD.TYPE, id: returnId, isDynamic: false });
            const returnOrderId = returnRecord.getValue({ fieldId: RETURN_RECORD.FIELDS.RETURN_ORDER_ID });

            const form = serverWidget.createForm({ title: `Return ${returnOrderId} - Not Yet Delivered` });
            form.addPageInitMessage({
                type: message.Type.CONFIRMATION, title: 'Nothing to review yet',
                message: 'This return has not yet arrived at the return center -- there is nothing to physically inspect, so no decision can be made here.'
            });

            const field = form.addField({ id: 'custpage_detail', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
            field.defaultValue = buildReturnDetailHtml(returnRecord, findReturnLines(returnId))
                + `<div style="padding:10px 0;"><a href="${buildSuiteletUrl()}" style="${SECONDARY_BUTTON_STYLE}">Back to queue</a></div>`;

            return form;
        }

        /** Queue of every return still waiting on a human decision, oldest-synced first so nothing sits forgotten. */
        function buildListPage(errorMessage) {
            const form = serverWidget.createForm({ title: 'Walmart Returns - Pending Review' });
            if (errorMessage) {
                form.addPageInitMessage({ type: message.Type.ERROR, title: 'Error', message: errorMessage });
            }

            const pending = findPendingReturns();

            let html;
            if (!pending.length) {
                html = '<p style="padding:20px 0;">Nothing waiting on review right now.</p>';
            } else {
                const rows = pending.map((r) => {
                    const reviewUrl = buildSuiteletUrl({ custpage_return_id: r.id });
                    return '<tr>'
                        + `<td style="padding:6px 12px 6px 0;">${escapeHtml(r.returnOrderId)}</td>`
                        + `<td style="padding:6px 12px 6px 0;">${escapeHtml(r.poId)}</td>`
                        + `<td style="padding:6px 12px 6px 0;max-width:400px;">${escapeHtml(r.lines)}</td>`
                        + `<td style="padding:6px 12px 6px 0;">${escapeHtml(r.deliveredAt)}</td>`
                        + `<td style="padding:6px 12px 6px 0;max-width:300px;">${escapeHtml(r.walmartStatus)}</td>`
                        + `<td style="padding:6px 12px 6px 0;">${escapeHtml(r.lastSynced)}</td>`
                        + `<td style="padding:6px 0;"><a href="${reviewUrl}" style="${BUTTON_STYLE}">Review</a></td>`
                        + '</tr>';
                });
                html = `<p style="padding:10px 0;color:#666;">${pending.length}${pending.length >= MAX_LIST_ROWS ? '+' : ''} return(s) pending inspection.</p>`
                    + '<table style="border-collapse:collapse;">'
                    + '<tr style="text-align:left;border-bottom:2px solid #000;">'
                    + '<th style="padding:6px 12px 6px 0;">Return Order ID</th>'
                    + '<th style="padding:6px 12px 6px 0;">PO ID</th>'
                    + '<th style="padding:6px 12px 6px 0;">Lines</th>'
                    + '<th style="padding:6px 12px 6px 0;">Delivered to Us</th>'
                    + '<th style="padding:6px 12px 6px 0;">Walmart Status</th>'
                    + '<th style="padding:6px 12px 6px 0;">Last Synced</th>'
                    + '<th></th>'
                    + '</tr>'
                    + rows.join('')
                    + '</table>';
            }

            const listField = form.addField({ id: 'custpage_list', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
            listField.defaultValue = html;

            return form;
        }

        function findPendingReturns() {
            const returnSearch = search.create({
                type: RETURN_RECORD.TYPE,
                // DELIVERY_DATE stays empty until DELIVERED_AT_RETURN_CENTER webhook fires.
                filters: [
                    [RETURN_RECORD.FIELDS.REVIEW_STATUS, 'is', REVIEW_STATUS.PENDING_INSPECTION],
                    'AND',
                    [RETURN_RECORD.FIELDS.DELIVERY_DATE, 'isnotempty', '']
                ],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: RETURN_RECORD.FIELDS.RETURN_ORDER_ID }),
                    search.createColumn({ name: RETURN_RECORD.FIELDS.PO_ID }),
                    search.createColumn({ name: RETURN_RECORD.FIELDS.RETURN_LINES }),
                    search.createColumn({ name: RETURN_RECORD.FIELDS.RETURN_STATUS }),
                    search.createColumn({ name: RETURN_RECORD.FIELDS.DELIVERY_DATE }),
                    search.createColumn({ name: RETURN_RECORD.FIELDS.LAST_SYNCED, sort: search.Sort.ASC })
                ]
            });

            const results = returnSearch.run().getRange({ start: 0, end: MAX_LIST_ROWS }) || [];
            return results.map((r) => {
                return {
                    id: r.getValue({ name: 'internalid' }),
                    returnOrderId: r.getValue({ name: RETURN_RECORD.FIELDS.RETURN_ORDER_ID }) || '',
                    poId: r.getValue({ name: RETURN_RECORD.FIELDS.PO_ID }) || '',
                    lines: r.getValue({ name: RETURN_RECORD.FIELDS.RETURN_LINES }) || '',
                    deliveredAt: r.getValue({ name: RETURN_RECORD.FIELDS.DELIVERY_DATE }) || '',
                    walmartStatus: r.getValue({ name: RETURN_RECORD.FIELDS.RETURN_STATUS }) || '',
                    lastSynced: r.getValue({ name: RETURN_RECORD.FIELDS.LAST_SYNCED }) || ''
                };
            });
        }

        /**
         * Every customrecord_wal_return_line under one return, oldest line
         * number first. qtyApproved defaults to the full qtyRequested until a
         * reviewer has actually saved a decision (QTY_APPROVED left blank by
         * wm_mr_return_import.js's sync) -- that's what pre-fills the decision
         * form. Only used to build a fresh decision form (buildReviewPage()) or
         * a read-only detail view -- buildRefundConfirmPage()/handleConfirmRefund()
         * work from the in-flight decision carried on the form instead, since
         * nothing is written here until the refund actually succeeds.
         */
        function findReturnLines(returnId) {
            const lineSearch = search.create({
                type: RETURN_LINE_RECORD.TYPE,
                filters: [[RETURN_LINE_RECORD.FIELDS.PARENT, 'anyof', returnId]],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: RETURN_LINE_RECORD.FIELDS.LINE_NUMBER, sort: search.Sort.ASC }),
                    search.createColumn({ name: RETURN_LINE_RECORD.FIELDS.SKU }),
                    search.createColumn({ name: RETURN_LINE_RECORD.FIELDS.ITEM_NAME }),
                    search.createColumn({ name: RETURN_LINE_RECORD.FIELDS.QTY_REQUESTED }),
                    search.createColumn({ name: RETURN_LINE_RECORD.FIELDS.QTY_APPROVED }),
                    search.createColumn({ name: RETURN_LINE_RECORD.FIELDS.REJECTION_REASON }),
                    search.createColumn({ name: RETURN_LINE_RECORD.FIELDS.TOTAL_RETURN_VALUE }),
                    search.createColumn({ name: RETURN_LINE_RECORD.FIELDS.APPROVED_RETURN_VALUE })
                ]
            });

            const results = lineSearch.run().getRange({ start: 0, end: 100 }) || [];
            return results.map((r) => {
                const qtyRequested = parseInt(r.getValue({ name: RETURN_LINE_RECORD.FIELDS.QTY_REQUESTED }), 10) || 0;
                const qtyApprovedRaw = r.getValue({ name: RETURN_LINE_RECORD.FIELDS.QTY_APPROVED });
                const totalValueRaw = r.getValue({ name: RETURN_LINE_RECORD.FIELDS.TOTAL_RETURN_VALUE });
                const approvedValueRaw = r.getValue({ name: RETURN_LINE_RECORD.FIELDS.APPROVED_RETURN_VALUE });
                return {
                    id: r.getValue({ name: 'internalid' }),
                    lineNumber: parseInt(r.getValue({ name: RETURN_LINE_RECORD.FIELDS.LINE_NUMBER }), 10),
                    sku: r.getValue({ name: RETURN_LINE_RECORD.FIELDS.SKU }) || '',
                    productName: r.getValue({ name: RETURN_LINE_RECORD.FIELDS.ITEM_NAME }) || '',
                    qtyRequested,
                    qtyApproved: (qtyApprovedRaw !== '' && qtyApprovedRaw != null) ? parseInt(qtyApprovedRaw, 10) : qtyRequested,
                    reason: r.getValue({ name: RETURN_LINE_RECORD.FIELDS.REJECTION_REASON }) || '',
                    totalItemValue: (totalValueRaw !== '' && totalValueRaw != null) ? parseFloat(totalValueRaw) : null,
                    approvedItemValue: (approvedValueRaw !== '' && approvedValueRaw != null) ? parseFloat(approvedValueRaw) : null
                };
            });
        }

        /** Decision form -- only ever reached while review status is Pending Inspection (see buildPageForStatus()). */
        function buildReviewPage(returnId, errorMessage) {
            const returnRecord = record.load({ type: RETURN_RECORD.TYPE, id: returnId, isDynamic: false });
            const lines = findReturnLines(returnId);

            const form = serverWidget.createForm({
                title: `Review Return ${returnRecord.getValue({ fieldId: RETURN_RECORD.FIELDS.RETURN_ORDER_ID })}`
            });
            if (errorMessage) {
                form.addPageInitMessage({ type: message.Type.ERROR, title: 'Error', message: errorMessage });
            }

            const group = addSingleColumnGroup(form, 'custpage_detail_group');

            const detailField = form.addField({ id: 'custpage_detail', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
            detailField.defaultValue = buildReturnDetailHtml(returnRecord);

            const inspectedField = form.addField({
                id: 'custpage_inspected', type: serverWidget.FieldType.CHECKBOX,
                label: 'I have physically inspected this return and confirmed the quantities approved are unmounted/unused and within the 30-day return window',
                container: group
            });
            inspectedField.setHelpText({
                help: 'Required before submitting any line with a quantity approved greater than zero. Walmart has no field indicating whether a tire was mounted -- this has to be a physical check.'
            });

            if (!lines.length) {
                const noLinesField = form.addField({ id: 'custpage_no_lines', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
                noLinesField.defaultValue = '<p style="color:#a30000;">No line detail synced for this return yet -- re-run the return-import sync before reviewing.</p>';
            }

            const introField = form.addField({ id: 'custpage_lines_intro', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
            introField.defaultValue = lines.length
                ? '<p style="color:#666;font-size:13px;">Set the quantity approved for refund on each line. '
                    + 'A quantity less than what the customer requested needs a reason.</p>'
                : '';

            lines.forEach((line) => {
                const lineGroupId = `custpage_line_group_${line.id}`;
                const lineLabel = `Line ${line.lineNumber} -- ${line.sku}${line.productName ? ' (' + line.productName + ')' : ''}`;
                const lineGroup = form.addFieldGroup({ id: lineGroupId, label: lineLabel });
                lineGroup.isSingleColumn = true;

                const requestedField = form.addField({
                    id: `custpage_line_requested_${line.id}`, type: serverWidget.FieldType.TEXT,
                    label: 'Quantity Requested', container: lineGroupId
                });
                requestedField.defaultValue = String(line.qtyRequested);
                requestedField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });

                const approvedField = form.addField({
                    id: `custpage_line_qty_${line.id}`, type: serverWidget.FieldType.INTEGER,
                    label: 'Quantity Approved for Refund', container: lineGroupId
                });
                approvedField.defaultValue = String(line.qtyApproved);

                const reasonField = form.addField({
                    id: `custpage_line_reason_${line.id}`, type: serverWidget.FieldType.TEXT,
                    label: 'Reason (required if less than requested)', container: lineGroupId
                });
                reasonField.defaultValue = line.reason;

                addHiddenField(form, `custpage_line_value_${line.id}`, line.totalItemValue, lineGroupId);
                addHiddenField(form, `custpage_line_number_${line.id}`, line.lineNumber, lineGroupId);
                addHiddenField(form, `custpage_line_sku_${line.id}`, line.sku, lineGroupId);
                addHiddenField(form, `custpage_line_name_${line.id}`, line.productName, lineGroupId);
            });

            const lineIdsField = form.addField({ id: 'custpage_line_ids', type: serverWidget.FieldType.TEXT, label: 'Line Ids', container: group });
            lineIdsField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            lineIdsField.defaultValue = lines.map((l) => l.id).join(',');

            const returnIdField = form.addField({ id: 'custpage_return_id', type: serverWidget.FieldType.TEXT, label: 'Return Record ID', container: group });
            returnIdField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            returnIdField.defaultValue = String(returnId);

            const actionField = form.addField({ id: 'custpage_action', type: serverWidget.FieldType.TEXT, label: 'Action', container: group });
            actionField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            actionField.defaultValue = ACTION.SUBMIT;

            form.addSubmitButton({ label: 'Submit Decision' });

            const backField = form.addField({ id: 'custpage_back', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
            backField.defaultValue = `<div style="padding:10px 0;"><a href="${buildSuiteletUrl()}" style="${SECONDARY_BUTTON_STYLE}">Back to queue</a></div>`;

            return form;
        }

        /**
         * Shared status/tracking/lines/raw-JSON block used by the decision page,
         * the not-yet-delivered page, and the read-only "already handled" page.
         * lines: result of findReturnLines(returnRecord.id) -- callers already
         * have it or need it themselves, so it's passed in rather than re-queried here.
         */
        function buildReturnDetailHtml(returnRecord, lines) {
            const reviewStatus = returnRecord.getValue({ fieldId: RETURN_RECORD.FIELDS.REVIEW_STATUS });
            const isRefundResolved = reviewStatus === REVIEW_STATUS.REFUND_ISSUED || reviewStatus === REVIEW_STATUS.REFUNDED_WALMART_INITIATED;

            const rows = [
                ['Return Order ID', returnRecord.getValue({ fieldId: RETURN_RECORD.FIELDS.RETURN_ORDER_ID })],
                ['PO ID', returnRecord.getValue({ fieldId: RETURN_RECORD.FIELDS.PO_ID })],
                ['Return Delivered to Us', formatLoadedDate(returnRecord.getValue({ fieldId: RETURN_RECORD.FIELDS.DELIVERY_DATE })) || 'Not yet delivered to return center'],
                ['Walmart Status', returnRecord.getValue({ fieldId: RETURN_RECORD.FIELDS.RETURN_STATUS })],
                ['Tracking Number', returnRecord.getValue({ fieldId: RETURN_RECORD.FIELDS.TRACKING_NUMBER })],
                ['Label URL', returnRecord.getValue({ fieldId: RETURN_RECORD.FIELDS.LABEL_URL })],
                ['Review Status', reviewStatus],
                ['Reviewed On', formatLoadedDate(returnRecord.getValue({ fieldId: RETURN_RECORD.FIELDS.REVIEW_DATE }))],
                ['Refund Issued On', formatLoadedDate(returnRecord.getValue({ fieldId: RETURN_RECORD.FIELDS.REFUND_ISSUED_DATE }))],
                // Only meaningful once a refund has actually resolved -- a sync
                // attempt only ever happens from that point on (see
                // wm_mr_return_import.js's reduce()).
                isRefundResolved && ['QBO Synced', returnRecord.getValue({ fieldId: RETURN_RECORD.FIELDS.QBO_SYNCED }) ? 'Yes' : 'No'],
                ['Last Synced', formatLoadedDate(returnRecord.getValue({ fieldId: RETURN_RECORD.FIELDS.LAST_SYNCED }))],
                ['Error', returnRecord.getValue({ fieldId: RETURN_RECORD.FIELDS.ERROR })]
            ].filter(Boolean).filter(([, value]) => value);

            let html = '<table style="border-collapse:collapse;margin-bottom:16px;">'
                + rows.map(([label, value]) => `<tr><td style="padding:3px 12px 3px 0;color:#666;font-size:13px;">${escapeHtml(label)}</td>`
                    + `<td style="padding:3px 0;font-weight:bold;">${escapeHtml(value)}</td></tr>`).join('')
                + '</table>';

            if (lines && lines.length) {
                html += '<table style="border-collapse:collapse;margin-bottom:16px;">'
                    + '<tr style="text-align:left;border-bottom:1px solid #ccc;">'
                    + '<th style="padding:3px 12px 3px 0;">Line</th>'
                    + '<th style="padding:3px 12px 3px 0;">SKU</th>'
                    + '<th style="padding:3px 12px 3px 0;">Qty Requested</th>'
                    + '<th style="padding:3px 12px 3px 0;">Qty Approved</th>'
                    + '<th style="padding:3px 12px 3px 0;">Total Value</th>'
                    + '<th style="padding:3px 12px 3px 0;">Approved Value</th>'
                    + '<th style="padding:3px 0;">Reason</th>'
                    + '</tr>'
                    + lines.map((l) => '<tr>'
                        + `<td style="padding:3px 12px 3px 0;">${escapeHtml(l.lineNumber)}</td>`
                        + `<td style="padding:3px 12px 3px 0;">${escapeHtml(l.sku)}</td>`
                        + `<td style="padding:3px 12px 3px 0;">${escapeHtml(l.qtyRequested)}</td>`
                        + `<td style="padding:3px 12px 3px 0;">${escapeHtml(l.qtyApproved)}</td>`
                        + `<td style="padding:3px 12px 3px 0;">${escapeHtml(formatCurrency(l.totalItemValue))}</td>`
                        + `<td style="padding:3px 12px 3px 0;">${escapeHtml(formatCurrency(l.approvedItemValue))}</td>`
                        + `<td style="padding:3px 0;">${escapeHtml(l.reason)}</td>`
                        + '</tr>').join('')
                    + '</table>';
            }

            const rawJson = returnRecord.getValue({ fieldId: RETURN_RECORD.FIELDS.RAW_JSON });
            if (rawJson) {
                html += '<details style="margin-bottom:16px;"><summary style="cursor:pointer;font-weight:bold;">Raw JSON</summary>'
                    + `<pre style="white-space:pre-wrap;font-size:12px;background:#f7f7f7;padding:10px;border-radius:4px;">${escapeHtml(rawJson)}</pre></details>`;
            }
            return html;
        }

        /**
         * Reads back one line decision's worth of hidden/editable fields, keyed
         * off the custpage_line_ids hidden field -- shared by both the review
         * form (buildReviewPage()) and the confirm form (buildRefundConfirmPage()),
         * since both carry the same field set. Nothing here is re-queried from
         * the line records, so a stale search result can't disagree with what
         * the reviewer actually saw/submitted -- the decision only ever reads
         * from what was literally on the form.
         */
        function readLineDecisionsFromRequest(request) {
            const lineIds = (request.parameters.custpage_line_ids || '').split(',').filter(Boolean);
            return lineIds.map((lineId) => {
                const qtyRaw = request.parameters[`custpage_line_qty_${lineId}`];
                const valueRaw = request.parameters[`custpage_line_value_${lineId}`];
                return {
                    id: lineId,
                    lineNumber: parseInt(request.parameters[`custpage_line_number_${lineId}`], 10),
                    sku: request.parameters[`custpage_line_sku_${lineId}`] || '',
                    productName: request.parameters[`custpage_line_name_${lineId}`] || '',
                    qtyRequested: parseInt(request.parameters[`custpage_line_requested_${lineId}`], 10) || 0,
                    qtyApproved: (qtyRaw !== '' && qtyRaw != null) ? parseInt(qtyRaw, 10) : 0,
                    reason: (request.parameters[`custpage_line_reason_${lineId}`] || '').trim(),
                    valueRequested: (valueRaw !== '' && valueRaw != null) ? parseFloat(valueRaw) : null
                };
            });
        }

        function handleSubmit(context) {
            const request = context.request;
            const returnId = request.parameters.custpage_return_id;
            const inspected = request.parameters.custpage_inspected === 'T';

            if (!returnId) {
                context.response.writePage(buildListPage('Missing return record id -- please start again.'));
                return;
            }

            const lineDecisions = readLineDecisionsFromRequest(request);
            if (!lineDecisions.length) {
                context.response.writePage(buildReviewPage(returnId, 'No lines to review -- re-run the return-import sync before reviewing.'));
                return;
            }

            for (const line of lineDecisions) {
                if (line.qtyApproved < 0 || line.qtyApproved > line.qtyRequested) {
                    context.response.writePage(buildReviewPage(returnId, `Quantity approved on line ${line.id} must be between 0 and the quantity requested (${line.qtyRequested}).`));
                    return;
                }
                if (line.qtyApproved < line.qtyRequested && !line.reason) {
                    context.response.writePage(buildReviewPage(returnId, 'Enter a reason for any line where the quantity approved is less than the quantity requested.'));
                    return;
                }
            }

            const totalApproved = lineDecisions.reduce((sum, l) => sum + l.qtyApproved, 0);

            if (totalApproved > 0 && !inspected) {
                context.response.writePage(buildReviewPage(returnId, 'You must confirm physical inspection before approving any quantity.'));
                return;
            }

            const returnOrderId = search.lookupFields({
                type: RETURN_RECORD.TYPE, id: returnId, columns: [RETURN_RECORD.FIELDS.RETURN_ORDER_ID]
            })[RETURN_RECORD.FIELDS.RETURN_ORDER_ID];

            if (totalApproved === 0) {
                // This IS the final decision -- no refund call to make, so there's
                // nothing further to confirm. Persist it now.
                lineDecisions.forEach((line) => {
                    record.submitFields({
                        type: RETURN_LINE_RECORD.TYPE,
                        id: line.id,
                        values: {
                            [RETURN_LINE_RECORD.FIELDS.QTY_APPROVED]: line.qtyApproved,
                            [RETURN_LINE_RECORD.FIELDS.REJECTION_REASON]: line.reason,
                            [RETURN_LINE_RECORD.FIELDS.APPROVED_RETURN_VALUE]: 0
                        },
                        options: { enableSourcing: false, ignoreMandatoryFields: true }
                    });
                });
                record.submitFields({
                    type: RETURN_RECORD.TYPE,
                    id: returnId,
                    values: {
                        [RETURN_RECORD.FIELDS.REVIEW_STATUS]: REVIEW_STATUS.REJECTED,
                        [RETURN_RECORD.FIELDS.REVIEW_DATE]: new Date()
                    },
                    options: { enableSourcing: false, ignoreMandatoryFields: true }
                });
                sendShortfallNotificationEmail({ returnOrderId, lines: lineDecisions });
                context.response.writePage(buildResultPage({
                    success: true,
                    message: `Return ${returnOrderId} marked Rejected -- no quantity approved for refund. A notification has been sent to the team -- this now needs to be disputed by hand in Seller Center.`,
                    extraLinkUrl: RETURNS_DASHBOARD_URL,
                    extraLinkLabel: 'Open Seller Center'
                }));
                return;
            }

            // At least one line has a quantity approved -- nothing is persisted
            // anywhere yet. The decision is carried forward as hidden fields into
            // the confirm screen and only becomes durable once the refund call
            // there actually succeeds (see handleConfirmRefund()).
            context.response.writePage(buildRefundConfirmPage(returnId, lineDecisions));
        }

        /** Confirmation screen before actually sending the refund -- reached right after submitting a decision with at least one line approved > 0. Nothing is persisted yet: review status stays Pending Inspection until the refund call below actually succeeds and sets it to Refund Initiated. */
        function buildRefundConfirmPage(returnId, lineDecisions, errorMessage) {
            const returnRecord = record.load({ type: RETURN_RECORD.TYPE, id: returnId, isDynamic: false });
            const returnOrderId = returnRecord.getValue({ fieldId: RETURN_RECORD.FIELDS.RETURN_ORDER_ID });
            const approvedLines = lineDecisions.filter((l) => l.qtyApproved > 0);

            const form = serverWidget.createForm({ title: `Confirm Refund - Return ${returnOrderId}` });
            if (errorMessage) {
                form.addPageInitMessage({ type: message.Type.ERROR, title: 'Error', message: errorMessage });
            }

            const group = addSingleColumnGroup(form, 'custpage_refund_group');

            let customerOrderId = null;
            try {
                customerOrderId = getCustomerOrderId(returnRecord.getValue({ fieldId: RETURN_RECORD.FIELDS.RAW_JSON }));
            } catch (e) {
                form.addPageInitMessage({ type: message.Type.ERROR, title: 'Error', message: e.message });
            }

            const linesHtml = approvedLines.length
                ? '<ul>' + approvedLines.map((l) => `<li>${escapeHtml(l.productName || l.sku)} (${escapeHtml(l.sku)}) -- `
                    + `refunding ${escapeHtml(l.qtyApproved)} of ${escapeHtml(l.qtyRequested)} requested`
                    + `${l.qtyApproved < l.qtyRequested ? ` <span style="color:#a30000;">(${escapeHtml(l.reason)})</span>` : ''}</li>`).join('') + '</ul>'
                : '<p>No lines approved for refund.</p>';

            const html = '<p style="padding:10px 0;color:#a30000;font-weight:bold;">Sending the refund issues it through '
                + 'Walmart\'s API immediately and cannot be undone from this tool.</p>'
                + `<p>Customer Order ID: <strong>${escapeHtml(customerOrderId || 'unknown')}</strong></p>`
                + linesHtml;

            const detailField = form.addField({ id: 'custpage_refund_detail', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
            detailField.defaultValue = html;

            // Re-emits the same hidden fields readLineDecisionsFromRequest() reads,
            // so the decision survives this screen without ever being written to
            // customrecord_wal_return_line -- only handleConfirmRefund()'s success
            // path does that, once the refund call has actually gone through.
            lineDecisions.forEach((line) => {
                addHiddenField(form, `custpage_line_number_${line.id}`, line.lineNumber, group);
                addHiddenField(form, `custpage_line_sku_${line.id}`, line.sku, group);
                addHiddenField(form, `custpage_line_name_${line.id}`, line.productName, group);
                addHiddenField(form, `custpage_line_requested_${line.id}`, line.qtyRequested, group);
                addHiddenField(form, `custpage_line_qty_${line.id}`, line.qtyApproved, group);
                addHiddenField(form, `custpage_line_reason_${line.id}`, line.reason, group);
                addHiddenField(form, `custpage_line_value_${line.id}`, line.valueRequested, group);
            });
            addHiddenField(form, 'custpage_line_ids', lineDecisions.map((l) => l.id).join(','), group);

            const returnIdField = form.addField({ id: 'custpage_return_id', type: serverWidget.FieldType.TEXT, label: 'Return Record ID', container: group });
            returnIdField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            returnIdField.defaultValue = String(returnId);

            const actionField = form.addField({ id: 'custpage_action', type: serverWidget.FieldType.TEXT, label: 'Action', container: group });
            actionField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            actionField.defaultValue = ACTION.CONFIRM_REFUND;

            form.addSubmitButton({ label: 'Send Refund to Walmart' });

            const backField = form.addField({ id: 'custpage_back', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
            backField.defaultValue = `<div style="padding:10px 0;"><a href="${buildSuiteletUrl()}" style="${SECONDARY_BUTTON_STYLE}">Back to queue</a></div>`;

            return form;
        }

        function handleConfirmRefund(context) {
            const request = context.request;
            const returnId = request.parameters.custpage_return_id;
            if (!returnId) {
                context.response.writePage(buildListPage('Missing return record id -- please start again.'));
                return;
            }

            const lineDecisions = readLineDecisionsFromRequest(request);
            const returnRecord = record.load({ type: RETURN_RECORD.TYPE, id: returnId, isDynamic: false });
            const returnOrderId = returnRecord.getValue({ fieldId: RETURN_RECORD.FIELDS.RETURN_ORDER_ID });

            try {
                const customerOrderId = getCustomerOrderId(returnRecord.getValue({ fieldId: RETURN_RECORD.FIELDS.RAW_JSON }));
                if (!customerOrderId) throw new Error("This return's stored data is missing customerOrderId -- cannot issue a refund.");

                const approvedLines = lineDecisions.filter((l) => l.qtyApproved > 0);
                if (!approvedLines.length) throw new Error('No lines approved for refund -- cannot issue a refund.');

                submitReturnRefund({ returnOrderId, customerOrderId, lines: approvedLines });

                // Only now that the refund call has actually succeeded does the
                // decision become durable -- written to every line (including the
                // ones at 0/unapproved) and the parent flipped to Refund Initiated
                // in the same breath. The return import Map/Reduce script will
                // handle RETURN_INVOICED events when Walmart confirms the refund;
                // at that point review status becomes Refund Issued.
                lineDecisions.forEach((line) => {
                    const approvedValue = (line.valueRequested != null && line.qtyRequested > 0)
                        ? (line.valueRequested / line.qtyRequested) * line.qtyApproved
                        : null;
                    record.submitFields({
                        type: RETURN_LINE_RECORD.TYPE,
                        id: line.id,
                        values: {
                            [RETURN_LINE_RECORD.FIELDS.QTY_APPROVED]: line.qtyApproved,
                            [RETURN_LINE_RECORD.FIELDS.REJECTION_REASON]: line.reason,
                            [RETURN_LINE_RECORD.FIELDS.APPROVED_RETURN_VALUE]: approvedValue
                        },
                        options: { enableSourcing: false, ignoreMandatoryFields: true }
                    });
                });
                record.submitFields({
                    type: RETURN_RECORD.TYPE,
                    id: returnId,
                    values: {
                        [RETURN_RECORD.FIELDS.REVIEW_STATUS]: REVIEW_STATUS.REFUND_INITIATED,
                        [RETURN_RECORD.FIELDS.REVIEW_DATE]: new Date()
                    },
                    options: { enableSourcing: false, ignoreMandatoryFields: true }
                });

                const totalRequested = lineDecisions.reduce((sum, l) => sum + l.qtyRequested, 0);
                const totalApproved = lineDecisions.reduce((sum, l) => sum + l.qtyApproved, 0);
                if (totalApproved < totalRequested) {
                    sendShortfallNotificationEmail({ returnOrderId, lines: lineDecisions });
                }

                context.response.writePage(buildResultPage({
                    success: true,
                    message: `Refund submitted to Walmart for return ${returnOrderId}.`
                }));
            } catch (e) {
                log.error('Return review - refund submission failed', {
                    returnId, returnOrderId, errorName: e && e.name, errorMessage: e && e.message
                });
                context.response.writePage(buildRefundConfirmPage(returnId, lineDecisions, e && e.message));
            }
        }

        /** Pulls customerOrderId out of the return's stored raw GET /v3/returns response -- per-line detail now comes from customrecord_wal_return_line, not this. */
        function getCustomerOrderId(rawJson) {
            if (!rawJson) throw new Error('This return has no raw Walmart data synced yet -- re-run the return-import sync before sending a refund.');
            let parsed;
            try {
                parsed = JSON.parse(rawJson);
            } catch (e) {
                throw new Error('Stored raw Walmart data for this return is not valid JSON -- re-run the return-import sync.');
            }
            return parsed.customerOrderId || null;
        }

        /** POST /v3/returns/{returnOrderId}/refund, for exactly the lines/quantities the reviewer approved -- lines here is already filtered to qtyApproved > 0. Every Walmart return line seen so far uses EACH; not worth storing per line for that. */
        function submitReturnRefund(params) {
            const { returnOrderId, customerOrderId, lines } = params;
            const ctx = getScriptParams();
            const baseUrl = BASE_URLS[ctx.environment] || BASE_URLS.SANDBOX;
            const correlationId = random.generateUUID();
            const accessToken = getWalmartAccessToken({ clientId: ctx.clientId, clientSecret: ctx.clientSecret, baseUrl, correlationId });

            const payload = {
                customerOrderId,
                refundLines: lines
                    .filter((l) => l.lineNumber != null)
                    .map((l) => ({
                        returnOrderLineNumber: l.lineNumber,
                        quantity: { unitOfMeasure: 'EACH', measurementValue: l.qtyApproved }
                    }))
            };
            const requestBody = JSON.stringify(payload);
            log.audit(`Walmart refund request body (returnOrderId=${returnOrderId}, correlationId=${correlationId})`, requestBody);

            const response = https.post({
                url: `${baseUrl}/v3/returns/${encodeURIComponent(returnOrderId)}/refund`,
                body: requestBody,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'WM_QOS.CORRELATION_ID': correlationId,
                    ...(ctx.environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            logHttpResponse(`Walmart refund request (returnOrderId=${returnOrderId})`, response, correlationId);
            if (response.code !== 200) {
                throw new Error(`Walmart refund request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }
            return safeJsonParse(response.body, correlationId, 'refund');
        }

        /**
         * Sent whenever total quantity approved is less than total quantity
         * requested across the return. Walmart has no seller-callable
         * return rejection API, so any shortfall has to be disputed by hand in
         * Seller Center; this is the heads-up with exactly what to dispute.
         */
        function sendShortfallNotificationEmail(params) {
            const { returnOrderId, lines } = params;
            const shortLines = lines.filter((l) => l.qtyApproved < l.qtyRequested);
            if (!shortLines.length) return;
            const fullyRejected = lines.every((l) => l.qtyApproved === 0);

            const linesHtml = shortLines.map((l) => '<li>'
                + `Line number: ${escapeHtml(l.lineNumber)} -- SKU ${escapeHtml(l.sku)}<br>`
                + `Qty: ${escapeHtml(l.qtyRequested - l.qtyApproved)} of ${escapeHtml(l.qtyRequested)} requested not approved for refund<br>`
                + `Reason: ${escapeHtml(l.reason)}`
                + '</li>').join('');

            try {
                email.send({
                    author: RETURN_ALERT_AUTHOR,
                    recipients: RETURN_ALERT_RECIPIENTS,
                    subject: `Walmart Return ${returnOrderId} - ${fullyRejected ? 'Rejected' : 'Partially Rejected'}, Dispute Needed in Seller Center`,
                    body: '<html><body>'
                        + `<p>Return number <strong>${escapeHtml(returnOrderId)}</strong> has return items that have been rejected:</p>`
                        + `<ul>${linesHtml}</ul>`
                        + '<p>Please visit the returns dashboard on the Walmart Seller Center website to initiate a return dispute within 48 hours for the quantity not approved.</p>'
                        + `<p><a href="${RETURNS_DASHBOARD_URL}">Open Seller Center</a></p>`
                        + '</body></html>'
                });
                log.audit('Return review - shortfall notification email sent', { returnOrderId });
            } catch (emailError) {
                log.error('Return review - failed to send shortfall notification email', {
                    returnOrderId, errorMessage: emailError && emailError.message
                });
            }
        }

        /** Read-only detail for a return that isn't at Pending Inspection -- Rejected, Refund Initiated, Refund Issued, or Refunded (Walmart-Initiated). */
        function buildAlreadyHandledPage(returnId) {
            const returnRecord = record.load({ type: RETURN_RECORD.TYPE, id: returnId, isDynamic: false });
            const reviewStatus = returnRecord.getValue({ fieldId: RETURN_RECORD.FIELDS.REVIEW_STATUS });
            const returnOrderId = returnRecord.getValue({ fieldId: RETURN_RECORD.FIELDS.RETURN_ORDER_ID });

            const form = serverWidget.createForm({ title: `Return ${returnOrderId} - ${reviewStatus}` });
            form.addPageInitMessage({
                type: message.Type.CONFIRMATION, title: 'Already decided',
                message: `This return's review status is "${reviewStatus}" -- nothing left to do here.`
            });

            const field = form.addField({ id: 'custpage_detail', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
            field.defaultValue = buildReturnDetailHtml(returnRecord, findReturnLines(returnId))
                + `<div style="padding:10px 0;"><a href="${buildSuiteletUrl()}" style="${SECONDARY_BUTTON_STYLE}">Back to queue</a></div>`;

            return form;
        }

        function buildResultPage(params) {
            const { success, message: resultMessage, extraLinkUrl, extraLinkLabel } = params;
            const form = serverWidget.createForm({ title: success ? 'Decision Recorded' : 'Submission Failed' });

            const resultField = form.addField({ id: 'custpage_result', type: serverWidget.FieldType.LONGTEXT, label: 'Result' });
            resultField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
            resultField.defaultValue = (success ? 'Success. ' : 'Error. ') + (resultMessage || '');

            const nextField = form.addField({ id: 'custpage_next', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
            nextField.defaultValue = '<div style="padding:10px 0;">'
                + (extraLinkUrl ? `<a href="${extraLinkUrl}" target="_blank" style="${SECONDARY_BUTTON_STYLE}margin-right:10px;">${escapeHtml(extraLinkLabel || 'Open Link')}</a>` : '')
                + `<a href="${buildSuiteletUrl()}" style="${SECONDARY_BUTTON_STYLE}">Back to queue</a>`
                + '</div>';

            return form;
        }

        /** This Suitelet's own URL -- shared by every "back to queue"/"review" link. */
        function buildSuiteletUrl(params) {
            const script = runtime.getCurrentScript();
            return url.resolveScript({
                scriptId: script.id, deploymentId: script.deploymentId, returnExternalUrl: false,
                params: params || {}
            });
        }

        /** Stacks every field assigned to it in one column instead of NetSuite's default two-column layout. */
        function addSingleColumnGroup(form, id) {
            const group = form.addFieldGroup({ id, label: ' ' });
            group.isSingleColumn = true;
            return id;
        }

        /** A hidden text field carrying one value through a form POST -- how the review and confirm screens pass a line decision along without persisting it until the refund succeeds. */
        function addHiddenField(form, id, value, container) {
            const field = form.addField({ id, type: serverWidget.FieldType.TEXT, label: id, container });
            field.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            field.defaultValue = value != null ? String(value) : '';
            return field;
        }

        /** record.load()'s getValue() returns a raw Date object for a Date/Time field (unlike a search result's already-formatted string) -- format it for display, or '' if unset. */
        function formatLoadedDate(dateValue) {
            if (!dateValue) return '';
            return format.format({ value: dateValue, type: format.Type.DATETIME });
        }

        function formatCurrency(amount) {
            if (amount == null || amount === '') return '';
            return `$${amount}`;
        }

        function escapeHtml(value) {
            return String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
        }

        function getWalmartAccessToken(params) {
            const { clientId, clientSecret, baseUrl, correlationId } = params;

            const basicAuth = encode.convert({
                string: `${clientId}:${clientSecret}`,
                inputEncoding: encode.Encoding.UTF_8,
                outputEncoding: encode.Encoding.BASE_64
            });

            const response = https.post({
                url: `${baseUrl}/v3/token`,
                body: 'grant_type=client_credentials',
                headers: {
                    'Authorization': `Basic ${basicAuth}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json',
                    'WM_QOS.CORRELATION_ID': correlationId,
                    'WM_SVC.NAME': 'Walmart Marketplace'
                }
            });

            logHttpResponse('Walmart token request', response, correlationId);
            if (response.code !== 200) {
                throw new Error(`Walmart token request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }

            const parsed = safeJsonParse(response.body, correlationId, 'token');
            if (!parsed.access_token) {
                throw new Error(`Walmart token response missing access_token (correlationId=${correlationId}): ${response.body}`);
            }
            return parsed.access_token;
        }

        function getScriptParams() {
            const script = runtime.getCurrentScript();
            return {
                clientId: script.getParameter({ name: PARAMS.CLIENT_ID }),
                clientSecret: script.getParameter({ name: PARAMS.CLIENT_SECRET }),
                environment: (script.getParameter({ name: PARAMS.ENVIRONMENT }) || 'SANDBOX').toUpperCase()
            };
        }

        function safeJsonParse(body, correlationId, context) {
            try {
                return JSON.parse(body);
            } catch (e) {
                log.error({
                    title: `Failed to parse Walmart response as JSON (${context}, correlationId=${correlationId})`,
                    details: body
                });
                throw new Error(`Walmart ${context} response was not valid JSON (correlationId=${correlationId}): ${body}`);
            }
        }

        function logHttpResponse(title, response, correlationId) {
            log[response.code >= 200 && response.code < 300 ? 'audit' : 'error']({
                title: `${title} (correlationId=${correlationId})`,
                details: JSON.stringify({ code: response.code, headers: response.headers, body: response.body })
            });
        }

        return { onRequest };
    }
);
