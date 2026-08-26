/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Syncs Walmart seller-fulfilled returns into customrecord_wal_return for
 * human review -- this script never calls approve/reject/refund itself.
 *
 * Two run modes:
 *   1. Single-return (webhook-triggered): custscript_wal_return_import_retorder_id
 *      set to one returnOrderId. Fires for RETURN_CREATED/DELIVERED/INVOICED alike.
 *   2. Reconciliation (hourly, no param): pages through GET /v3/returns
 *      (see getReturnOrdersPage()) until Walmart stops returning a nextCursor.
 *
 * Event-agnostic by design: regardless of which event triggered a run,
 * map() re-fetches GET /v3/returns?returnOrderId={returnOrderId} and syncs the record to
 * current truth, rather than branching per event type. Upsert, not
 * lock-and-never-touch, by externalid = 'wal-return-' + returnOrderId.
 * NetSuite enforces externalid uniqueness, so if two executions race to
 * create the same return's record, the loser's save() throws and falls
 * back to updating the winner's record instead.
 * 
 * Return records set custrecord_wal_return_review_status to "Pending Inspection"
 * upon creation (event type RETURN_DELIVERED). wm_sl_return_review allows users to
 * update this status by approving or rejecting the return after inspecting the merchandise.
 *
 * Per-line review decisions (how much of each line's requested quantity to
 * refund, and why if less than the full amount) live on customrecord_wal_return_line,
 * one child record per Walmart returnOrderLine -- see its field list below and
 * upsertReturnLineRecords(). custrecord_wal_return_lines (on the parent) stays a
 * flattened "SKU xQTY (REASON)" display summary only, not a source of truth.
 *
 * Known gaps: QBO reversal (credit memo + vendor credit) on a completed
 * refund is not implemented -- reduce() only flags the Walmart-Initiated
 * case, it doesn't post anything to QBO.
 *
 * Script parameters:
 *   custscript_wal_return_import_retorder_id - single Walmart returnOrderId (webhook path only; omit for hourly scan)
 *   custscript_wal_return_import_client_id  - Walmart Marketplace API Client ID
 *   custscript_wal_return_import_secret     - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_return_import_env        - "PRODUCTION" or "SANDBOX"
 *
 * customrecord_wal_return fields:
 *   externalid                            - 'wal-return-' + returnOrderId
 *   custrecord_wal_return_order_id         - Free-Form Text
 *   custrecord_wal_return_po_id            - Free-Form Text
 *   custrecord_wal_return_sales_order      - List/Record (Sales Order), best-effort match on otherrefnum == purchaseOrderId
 *   custrecord_wal_return_lines            - Free-Form Text (Long) -- "SKU xQTY (REASON)" per line, '; '-joined, display-only summary; customrecord_wal_return_line (below) is the source of truth for per-line review decisions
 *   custrecord_wal_return_walmart_status   - Free-Form Text
 *   custrecord_wal_return_review_status    - List/Record or Free-Form Text: Pending Inspection | Rejected | Refund Initiated | Refund Issued | Refunded (Walmart-Initiated) -- stays Pending Inspection through the review Suitelet's decision/confirm screens; only jumps straight to Rejected (0 approved) or Refund Initiated (refund call succeeded), set by that Suitelet, not this script
 *   custrecord_wal_return_tracking_number   - Free-Form Text -- carrierInfoList[].trackingNo, '; '-joined across returnLineGroups[].labels[]
 *   custrecord_wal_return_label_url         - Free-Form Text (Long) -- labels[].labelImageURL (the shipping label image, not a tracking-page URL), same join
 *   custrecord_wal_return_raw_json         - Free-Form Text (Long/Text Area)
 *   custrecord_wal_return_error            - Free-Form Text (Long) -- set on a map() sync failure, cleared on the next successful sync
 *   custrecord_wal_return_last_synced      - Date/Time
 *   custrecord_wal_return_delivery_date    - Date/Time -- earliest DELIVERED_AT_RETURN_CENTER eventTime across lines; null until delivered
 *
 * customrecord_wal_return_line fields (one child record per Walmart returnOrderLine,
 * upserted by upsertReturnLineRecords() every sync; qty_approved/rejection_reason/
 * approved_item_value are reviewer-owned and never overwritten here once set -- only
 * qty_requested/sku/item_name/total_item_value are kept current on resync. Unit of
 * measure isn't stored -- every Walmart return line seen so far uses EACH, and the
 * review Suitelet hardcodes that in its refund API call:
 *   externalid                              - 'wal-return-line-' + returnOrderId + '-' + returnOrderLineNumber
 *   custrecord_wal_retline_parent            - List/Record (customrecord_wal_returns)
 *   custrecord_wal_retline_number            - Integer -- Walmart's returnOrderLineNumber
 *   custrecord_wal_retline_sku               - Free-Form Text
 *   custrecord_wal_retline_item_name         - Free-Form Text
 *   custrecord_wal_retline_qty_requested     - Integer -- quantity.measurementValue, rounded (Walmart sends it as a float)
 *   custrecord_wal_retline_qty_approved      - Integer -- set by the review Suitelet, not this script; blank until reviewed
 *   custrecord_wal_retline_rejection_reason  - Free-Form Text (Long) -- set by the review Suitelet, not this script
 *   custrecord_wal_retline_total_value        - Currency -- unitPrice * qtyRequested, kept current every sync
 *   custrecord_wal_retline_approved_value     - Currency -- set by the review Suitelet, not this script; blank until reviewed
 *
 * TODO: RETURN_ALERT_AUTHOR (below) is a placeholder -- set it to a real
 * NetSuite employee internal id before this can send email.
 */
define(
    ['N/record', 'N/search', 'N/runtime', 'N/https', 'N/encode', 'N/log', 'N/crypto/random', 'N/email'],
    (record, search, runtime, https, encode, log, random, email) => {

        const BASE_URLS = {
            PRODUCTION: 'https://marketplace.walmartapis.com',
            SANDBOX: 'https://sandbox.walmartapis.com'
        };

        // 30-day return eligibility window + 1-day buffer. Filters on
        // returnLastModifiedStartDate, not creation date -- see getInputData().
        const RECONCILIATION_LOOKBACK_DAYS = 31;

        const PARAMS = {
            RETURN_ORDER_ID: 'custscript_wal_return_import_retorder_id',
            CLIENT_ID: 'custscript_wal_return_import_client_id',
            CLIENT_SECRET: 'custscript_wal_return_import_secret',
            ENVIRONMENT: 'custscript_wal_return_import_env',
            // Set to 'T' only by the webhook handler's RETURN_DELIVERED path,
            // which already sent the delivered alert itself -- tells reduce() not
            // to send a duplicate. Never set on the hourly reconciliation run, so
            // that run's own diff-based detection is untouched (still the safety
            // net for a missed/delayed webhook).
            ALERT_ALREADY_SENT: 'custscript_wal_return_import_alert_sent'
        };

        const RETURN_RECORD = {
            TYPE: 'customrecord_wal_returns',
            FIELDS: {
                RETURN_ORDER_ID: 'custrecord_wal_return_order_id',              // Walmart's returnOrderId
                PO_ID: 'custrecord_wal_return_po_id',                           // Walmart purchaseOrderId of the original order this return came from
                SALES_ORDER: 'custrecord_wal_return_sales_order',               // matching NetSuite Sales Order, found via otherrefnum == PO_ID; blank if no match
                RETURN_LINES: 'custrecord_wal_return_lines',                    // one "SKU xQTY (REASON)" entry per line, '; '-joined -- sku/qty/reason for a line always stay together
                RETURN_STATUS: 'custrecord_wal_return_status',                  // Walmart's own status/eventTag string, overwritten every sync -- NOT the human review decision
                REVIEW_STATUS: 'custrecord_wal_return_review_status',           // the human decision (see REVIEW_STATUS below) -- map()/reduce() only ever set this on creation or the Walmart-Initiated case, never overwrite an existing human choice
                TRACKING_NUMBER: 'custrecord_wal_return_tracking_num',          // carrierInfoList[].trackingNo, '; '-joined across returnLineGroups[].labels[]
                LABEL_URL: 'custrecord_wal_return_tracking_label_url',          // labels[].labelImageURL -- the shipping label image, NOT a tracking-page URL (Walmart's schema has no such thing)
                RAW_JSON: 'custrecord_wal_return_raw_json',                     // full unparsed GET /v3/returns/{returnOrderId} response, kept so nothing is lost if the guessed field paths above are wrong
                ERROR: 'custrecord_wal_return_error',                           // set by map()'s catch on a sync failure (recordSyncError()), cleared on the next successful sync
                LAST_SYNCED: 'custrecord_wal_return_last_sync',                 // timestamp of the last successful sync from Walmart
                DELIVERY_DATE: 'custrecord_wal_return_delivery_date',           // earliest DELIVERED_AT_RETURN_CENTER eventTime across lines -- null if not delivered yet; NOT the same as line.status (which can move past DELIVERED to COMPLETED between syncs)
                REFUND_ISSUED_DATE: 'custrecord_wal_return_refund_issued_date'  // date that Walmart sends the RETURN_INVOICED webhook, confirmed that the refund has been issued to the customer
            }
        };

        const REVIEW_STATUS = {
            PENDING_INSPECTION: 'Pending Inspection',                   // default on creation -- nobody has physically inspected the returned tire yet
            REJECTED: 'Rejected',                                       // inspected and found ineligible -- set by the review Suitelet, not this script
            REFUND_INITIATED: 'Refund Initiated',                       // approved and the refund call has been made -- set by the review Suitelet, not this script
            REFUND_ISSUED: 'Refund Issued',                             // Walmart confirms the refund posted, following our own approve/refund action
            REFUNDED_WALMART_INITIATED: 'Refunded (Walmart-Initiated)'  // set by reduce() when Walmart refunded on its own while this was still Pending Inspection -- nobody here approved it
        };

        const RETURN_LINE_RECORD = {
            TYPE: 'customrecord_wal_return_line',
            FIELDS: {
                PARENT: 'custrecord_wal_retline_parent',              // List/Record -> customrecord_wal_returns
                LINE_NUMBER: 'custrecord_wal_retline_number',         // Walmart's returnOrderLineNumber
                SKU: 'custrecord_wal_retline_sku',
                ITEM_NAME: 'custrecord_wal_retline_item_name',
                QTY_REQUESTED: 'custrecord_wal_retline_qty_requested', // quantity.measurementValue -- kept current every sync
                QTY_APPROVED: 'custrecord_wal_retline_qty_approved',   // reviewer-owned -- this script never sets or overwrites it
                REJECTION_REASON: 'custrecord_wal_retline_rejection_reason', // reviewer-owned -- this script never sets or overwrites it
                TOTAL_RETURN_VALUE: 'custrecord_wal_retline_total_value',   // unitPrice * qtyRequested -- kept current every sync
                APPROVED_RETURN_VALUE: 'custrecord_wal_retline_approved_value' // reviewer-owned -- this script never sets or overwrites it
            }
        };

        // TODO: return alert author
        const RETURN_ALERT_AUTHOR = 126970; // Me
        const RETURN_ALERT_RECIPIENTS = [
        // 12493, // Nick
        // 82292, // Moka Kash
        // 28068, // Camilo Espinosa
        // 13     // Ricky Chavez
        126970 // Me
    ];

        /** JSON.parse that logs the raw body before throwing, so a malformed response is visible in the log even though the parse error message itself won't show it. */
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
                returnOrderId: script.getParameter({ name: PARAMS.RETURN_ORDER_ID }) || null,
                clientId: script.getParameter({ name: PARAMS.CLIENT_ID }),
                clientSecret: script.getParameter({ name: PARAMS.CLIENT_SECRET }),
                environment: (script.getParameter({ name: PARAMS.ENVIRONMENT }) || 'SANDBOX').toUpperCase(),
                deliveryEmailAlertAlreadySentByWebhookHandler: script.getParameter({ name: PARAMS.ALERT_ALREADY_SENT }) === 'T'
            };
        }

        /**
         * One page of GET /v3/returns.
         * @returns {{ returnOrderIds: string[], nextCursor: string|undefined }}
         */
        function getReturnOrdersPage(params) {
            const { accessToken, baseUrl, nextCursor, correlationId, environment, returnLastModifiedStartDate } = params;

            const url = `${baseUrl}/v3/returns?returnLastModifiedStartDate=${encodeURIComponent(returnLastModifiedStartDate)}`
                + (nextCursor ? `&nextCursor=${encodeURIComponent(nextCursor)}` : '');

            const response = https.get({
                url,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'WM_QOS.CORRELATION_ID': correlationId,
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'Accept': 'application/json'
                }
            });

            logHttpResponse('Walmart returns list request', response, correlationId);
            if (response.code !== 200) {
                throw new Error(`Walmart returns list request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }

            const parsed = safeJsonParse(response.body, correlationId, 'returns list');

            const returnOrders = parsed.returnOrders || [];
            if (!Array.isArray(returnOrders) || returnOrders.length === 0) {
                log.audit('Returns list request returned no recognizable returnOrders array', {
                    responseKeys: Object.keys(parsed || {})
                });
            }

            return {
                returnOrderIds: (Array.isArray(returnOrders) ? returnOrders : [])
                    .map((r) => r && r.returnOrderId)
                    .filter(Boolean)
                    .map(String),
                nextCursor: parsed.meta && parsed.meta.nextCursor
            };
        }

        /**
         * Webhook path: return just the one return id passed via script param.
         * Hourly path: pages through GET /v3/returns filtered to
         * returnLastModifiedStartDate >= RECONCILIATION_LOOKBACK_DAYS ago.
         */
        function getInputData() {
            const ctx = getScriptParams();
            const correlationId = random.generateUUID();

            if (ctx.returnOrderId) {
                log.audit('Single return mode', { returnOrderId: ctx.returnOrderId });
                return [ctx.returnOrderId];
            }

            log.audit('Hourly reconciliation mode', 'No return id param set; scanning GET /v3/returns.');

            const baseUrl = BASE_URLS[ctx.environment] || BASE_URLS.SANDBOX;
            const accessToken = getWalmartAccessToken({
                clientId: ctx.clientId,
                clientSecret: ctx.clientSecret,
                baseUrl,
                correlationId
            });

            const returnLastModifiedStartDate = new Date(Date.now() - RECONCILIATION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

            const allReturnOrderIds = [];
            let nextCursor;
            do {
                const page = getReturnOrdersPage({
                    accessToken, baseUrl, nextCursor, correlationId, environment: ctx.environment, returnLastModifiedStartDate
                });
                allReturnOrderIds.push(...page.returnOrderIds);
                nextCursor = page.nextCursor;
            } while (nextCursor);

            log.audit('Returns found', { count: allReturnOrderIds.length });
            return allReturnOrderIds;
        }

        /**
         * Fetches current Walmart state for one return and syncs the tracking
         * record to match it. Never touches custrecord_wal_return_review_status
         * on an update.
         */
        function map(context) {
            const returnOrderId = JSON.parse(context.value);

            try {
                const ctx = getScriptParams();
                const correlationId = random.generateUUID();
                const baseUrl = BASE_URLS[ctx.environment] || BASE_URLS.SANDBOX;
                const accessToken = getWalmartAccessToken({
                    clientId: ctx.clientId, clientSecret: ctx.clientSecret, baseUrl, correlationId
                });

                const detail = getReturnOrderDetails({ accessToken, baseUrl, returnOrderId, correlationId, environment: ctx.environment });
                const returnFields = extractReturnFields(detail);
                const lineDetails = extractLineDetails(detail);
                const signals = computeStatusSignals(detail);

                const upsertResult = upsertReturnRecord({ returnOrderId, returnFields, rawJson: JSON.stringify(detail) });
                upsertReturnLineRecords({ parentId: upsertResult.id, returnOrderId, lines: lineDetails });

                let previousSignals = { anyLineDelivered: false, anyLineRefundIssued: false };
                if (upsertResult.previousRawJson) {
                    try {
                        previousSignals = computeStatusSignals(JSON.parse(upsertResult.previousRawJson));
                    } catch (e) {
                        log.error('Failed to parse previous raw JSON for status-signal comparison', {
                            returnOrderId, errorMessage: e.message
                        });
                    }
                }

                context.write(returnOrderId, {
                    returnOrderId,
                    signals,
                    previousSignals,
                    previousReviewStatus: upsertResult.previousReviewStatus,
                    recordId: upsertResult.id,
                    deliveryEmailAlertAlreadySentByWebhook: ctx.deliveryEmailAlertAlreadySentByWebhookHandler
                });
            } catch (e) {
                const errorMessage = (e && e.message) || String(e);
                log.error('Failed to sync return', {
                    returnOrderId,
                    errorName: e && e.name,
                    errorMessage
                });
                recordSyncError(returnOrderId, errorMessage);
            }
        }

        /**
         * Surfaces a map() failure on the return record itself, not just the
         * execution log -- creates a minimal stub record (return id + error +
         * default review status) if this returnOrderId has never synced
         * successfully, so a return that fails on its very first sync isn't
         * invisible too. Best-effort: if this write itself fails, that's logged
         * and swallowed rather than thrown, since map() is already inside its
         * own catch handling the original sync failure.
         */
        function recordSyncError(returnOrderId, errorMessage) {
            const externalId = 'wal-return-' + returnOrderId;
            try {
                const existing = findReturnRecord(externalId);
                if (existing) {
                    record.submitFields({
                        type: RETURN_RECORD.TYPE,
                        id: existing.id,
                        values: { [RETURN_RECORD.FIELDS.ERROR]: errorMessage },
                        options: { enableSourcing: false, ignoreMandatoryFields: true }
                    });
                    return;
                }

                const returnRecord = record.create({ type: RETURN_RECORD.TYPE, isDynamic: false });
                returnRecord.setValue({ fieldId: 'externalid', value: externalId });
                returnRecord.setValue({ fieldId: RETURN_RECORD.FIELDS.RETURN_ORDER_ID, value: String(returnOrderId) });
                returnRecord.setValue({ fieldId: RETURN_RECORD.FIELDS.REVIEW_STATUS, value: REVIEW_STATUS.PENDING_INSPECTION });
                returnRecord.setValue({ fieldId: RETURN_RECORD.FIELDS.ERROR, value: errorMessage });
                returnRecord.save({ enableSourcing: false, ignoreMandatoryFields: true });
            } catch (writeError) {
                log.error('Failed to record sync error on return record', {
                    returnOrderId, errorMessage: writeError && writeError.message
                });
            }
        }

        /** Before/after comparisons live here rather than in map() so a retried/re-run map() for the same return can't re-fire an alert or re-flag a status transition that already happened. */
        function reduce(context) {
            const mapResult = JSON.parse(context.values[0]);
            const { returnOrderId, signals, previousSignals, previousReviewStatus, recordId, deliveryEmailAlertAlreadySentByWebhook } = mapResult;

            const justDelivered = signals.anyLineDelivered && !previousSignals.anyLineDelivered;
            if (justDelivered && !deliveryEmailAlertAlreadySentByWebhook) {
                sendReturnDeliveredAlertEmail({ returnOrderId });
            }

            // Does the walmart returnTrackingDetail show a refund was issued?
            const walmartShowsRefunded = signals.anyLineRefundIssued; 

            // Does our tracking record signal that the merchandise was inspected and a refund was initiated through the API?
            const refundInitiated = previousReviewStatus === REVIEW_STATUS.REFUND_INITIATED;

            // Does our tracking record signal that the merchandise has not yet been inspected to determine if a refund should be issued?
            const noHumanDecisionYet = previousReviewStatus === REVIEW_STATUS.PENDING_INSPECTION || !previousReviewStatus;
            
            // We are required to send a response to customer or Walmart Customer Care inquiries within 48 hours.
            // If we do not respond in 48 hours, Walmart may cancel or refund orders automatically.
            // Order cancellations or refunds due to failer to respond within 48 hours cannot be disputed.
            // https://marketplacelearn.walmart.com/guides/Order%20management/Customer%20care/Customer-Care-policy
            if (walmartShowsRefunded && noHumanDecisionYet) {
                log.audit('Return refunded without going through NetSuite review -- Walmart acted unilaterally', {
                    returnOrderId, recordId
                });
                try {
                    record.submitFields({
                        type: RETURN_RECORD.TYPE,
                        id: recordId,
                        values: { [RETURN_RECORD.FIELDS.REVIEW_STATUS]: REVIEW_STATUS.REFUNDED_WALMART_INITIATED },
                        options: { enableSourcing: false, ignoreMandatoryFields: true }
                    });
                } catch (updateError) {
                    log.error('Failed to flag Walmart-initiated refund', {
                        returnOrderId, recordId, errorMessage: updateError.message
                    });
                }
            }

            // Handle RETURN_INVOICED webhooks.
            // Updates review status to Refund Issued and sets refund issued date. 
            if (walmartShowsRefunded && refundInitiated) {
                log.audit('Refund confirmed by Walmart.', {returnOrderId, recordId});
                try {
                    record.submitFields({
                        type: RETURN_RECORD.TYPE,
                        id: recordId,
                        values: {
                            [RETURN_RECORD.FIELDS.REVIEW_STATUS]: REVIEW_STATUS.REFUND_ISSUED,
                            [RETURN_RECORD.FIELDS.REFUND_ISSUED_DATE]: new Date(signals.refundIssuedDate)
                        },
                        options: { enableSourcing: false, ignoreMandatoryFields: true }
                    });
                } catch (updateError) {
                    log.error('Failed to update record status to Refund Issued', {
                        returnOrderId, recordId, errorMessage: updateError.message
                    });
                }
            }
        }

        /**
         * Return status DELIVERED has exactly one eventTag (DELIVERED_AT_RETURN_CENTER),
         * so status alone is unambiguous. COMPLETED covers five different
         * eventTags (REFUND_INITIATED, REFUND_ISSUED, RETURN_CANCELLED,
         * INTRANSIT_AFTER_INVOICE, DELIVERED_AFTER_INVOICE) with very different
         * meanings, so refund detection has to check eventTag, not status.
         */
        function computeStatusSignals(detail) {
            const lines = Array.isArray(detail.returnOrderLines) ? detail.returnOrderLines : [];
            const anyLineDelivered = lines.some((line) => line.status === 'DELIVERED');

            let refundIssuedDate = null;
            const anyLineRefundIssued = lines.some((line) => {
                const events = Array.isArray(line.returnTrackingDetail) ? line.returnTrackingDetail : [];
                const refundEvent = events.find((event) => event.eventTag === 'REFUND_ISSUED');
                if (refundEvent && refundEvent.eventTime) {
                    const eventDate = new Date(refundEvent.eventTime);
                    if (!refundIssuedDate || eventDate < refundIssuedDate) {
                        refundIssuedDate = eventDate;
                    }
                }
                return !!refundEvent;
            });
            return { anyLineDelivered, anyLineRefundIssued, refundIssuedDate };
        }

        function sendReturnDeliveredAlertEmail(params) {
            const { returnOrderId } = params;
            try {
                email.send({
                    author: RETURN_ALERT_AUTHOR,
                    recipients: RETURN_ALERT_RECIPIENTS,
                    subject: `Walmart Return ${returnOrderId} - Delivered, Needs Inspection`,
                    body: '<html><body>'
                        + `<p>Return <strong>${returnOrderId}</strong> has arrived at the return center.</p>`
                        + '<p>Someone needs to physically inspect it (unmounted, unused, within the return window) '
                        + 'and record the outcome in the return review tool before it can be approved/rejected.</p>'
                        + '</body></html>'
                });
                log.audit('Return-delivered alert email sent', { returnOrderId });
            } catch (emailError) {
                log.error('Failed to send return-delivered alert email', {
                    returnOrderId, errorMessage: emailError && emailError.message
                });
            }
        }

        /**
         * GET /v3/returns?returnOrderId={returnOrderId}
         */
        function getReturnOrderDetails(params) {
            const { accessToken, baseUrl, returnOrderId, correlationId, environment } = params;

            const response = https.get({
                url: `${baseUrl}/v3/returns?returnOrderId=${encodeURIComponent(returnOrderId)}`,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'WM_QOS.CORRELATION_ID': correlationId,
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'Accept': 'application/json'
                }
            });

            logHttpResponse(`Walmart return details request (returnOrderId=${returnOrderId})`, response, correlationId);
            if (response.code !== 200) {
                throw new Error(`Walmart return details request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }

            const parsed = safeJsonParse(response.body, correlationId, 'return details');
            const returnOrders = Array.isArray(parsed.returnOrders) ? parsed.returnOrders : [];
            if (!returnOrders.length) {
                throw new Error(`Walmart return details request returned no matching returnOrder for returnOrderId=${returnOrderId} (correlationId=${correlationId})`);
            }
            return returnOrders[0];
        }

        /**
         * lines: one "SKU xQTY (REASON)" entry per return line, '; '-joined --
         * sku/qty/reason for a line always travel together in the same entry.
         *
         * walmartStatus: one "status=X, event=Y, refund=Z" entry per line,
         * same '; '-join convention.
         *
         * deliveryDate: earliest DELIVERED_AT_RETURN_CENTER eventTime found
         * across any line's returnTrackingDetail[] -- deliberately NOT derived
         * from line.status, which can move past DELIVERED to COMPLETED between
         * syncs (see computeStatusSignals()'s comment on the same distinction).
         * null until that event actually shows up.
         */
        function extractReturnFields(detail) {
            const lines = detail.returnOrderLines || [];
            const lineList = Array.isArray(lines) ? lines : [];

            const lineSummaries = [];
            const statusList = [];
            let deliveryDate = null;
            lineList.forEach((line) => {
                const item = line.item || {};
                const sku = item.sku || 'UNKNOWN_SKU';
                const measurementValue = line.quantity && line.quantity.measurementValue;
                const qty = measurementValue != null ? String(measurementValue) : '?';
                const reason = line.returnReason || 'UNKNOWN_REASON';
                lineSummaries.push(`${sku} x${qty} (${reason})`);

                const trackingEvents = Array.isArray(line.returnTrackingDetail) ? line.returnTrackingDetail : [];
                const latestEventTag = trackingEvents.length ? trackingEvents[trackingEvents.length - 1].eventTag : null;
                const labeledParts = [
                    line.status && `status=${line.status}`,
                    latestEventTag && `event=${latestEventTag}`,
                    line.currentRefundStatus && `refund=${line.currentRefundStatus}`
                ].filter(Boolean);
                statusList.push(labeledParts.join(', '));

                const deliveredEvent = trackingEvents.find((event) => event.eventTag === 'DELIVERED_AT_RETURN_CENTER');
                if (deliveredEvent && deliveredEvent.eventTime) {
                    const eventDate = new Date(deliveredEvent.eventTime);
                    if (!deliveryDate || eventDate < deliveryDate) deliveryDate = eventDate;
                }
            });

            // Tracking/label info lives on returnLineGroups[], not returnOrderLines[] --
            // a separate array, so it's collected independently of the line loop above.
            const returnLineGroups = Array.isArray(detail.returnLineGroups) ? detail.returnLineGroups : [];
            const trackingNumbers = [];
            const labelUrls = [];
            returnLineGroups.forEach((group) => {
                const labels = Array.isArray(group.labels) ? group.labels : [];
                labels.forEach((label) => {
                    if (label.labelImageURL) labelUrls.push(label.labelImageURL);
                    const carrierInfoList = Array.isArray(label.carrierInfoList) ? label.carrierInfoList : [];
                    carrierInfoList.forEach((carrier) => {
                        if (carrier.trackingNo) trackingNumbers.push(carrier.trackingNo);
                    });
                });
            });
            const trackingNumber = trackingNumbers.join('; ') || null;
            const labelUrl = labelUrls.join('; ') || null;

            const purchaseOrderId = (lineList.length && lineList[0].purchaseOrderId) || null;

            if (lineList.length === 0) {
                return {
                    purchaseOrderId,
                    returnLines: null,
                    walmartStatus: null, trackingNumber, labelUrl,
                    deliveryDate: null
                };
            }

            return {
                purchaseOrderId,
                returnLines: lineSummaries.join('; '),
                walmartStatus: statusList.join('; ') || null,
                trackingNumber,
                labelUrl,
                deliveryDate
            };
        }

        /**
         * Per-line data for upsertReturnLineRecords() -- kept separate from
         * extractReturnFields()'s flattened display summary. Walmart sends
         * measurementValue as a float (e.g. 2.0) even though it's always a whole
         * unit count in practice -- rounded here since qty_requested is an
         * Integer field.
         */
        function extractLineDetails(detail) {
            const lines = Array.isArray(detail.returnOrderLines) ? detail.returnOrderLines : [];
            return lines
                .map((line) => {
                    const item = line.item || {};
                    const quantity = line.quantity || {};
                    const unitPrice = line.unitPrice && line.unitPrice.currencyAmount;
                    const qtyRequested = quantity.measurementValue != null ? Math.round(quantity.measurementValue) : null;
                    return {
                        lineNumber: line.returnOrderLineNumber,
                        sku: item.sku || 'UNKNOWN_SKU',
                        productName: item.productName || null,
                        qtyRequested,
                        totalItemValue: (unitPrice != null && qtyRequested != null) ? unitPrice * qtyRequested : null
                    };
                })
                .filter((line) => line.lineNumber != null);
        }

        function findSalesOrderByPurchaseOrderId(purchaseOrderId) {
            if (!purchaseOrderId) return null;
            try {
                
                const soSearch = search.create({
                    type: search.Type.TRANSACTION,
                    filters: [
                        search.createFilter({ name: 'type', operator: search.Operator.ANYOF, values: 'SalesOrd' }),
                        // Direct string filtering does not work for the 'otherrefnum' field.
                        // Replaced with formula text.
                        search.createFilter({
                            name: 'formulatext',
                            formula: '{otherrefnum}',
                            operator: search.Operator.IS,
                            values: String(purchaseOrderId)
                        }),
                        search.createFilter({ name: 'mainline', operator: search.Operator.IS, values: 'T' })
                    ],
                    columns: [
                        search.createColumn({ name: 'internalid' }),
                        search.createColumn({ name: 'otherrefnum' })
                    ]
                });
                const results = soSearch.run().getRange({ start: 0, end: 100 }) || [];
                log.audit('Sales Order lookup by purchaseOrderId', {
                    purchaseOrderId,
                    // filterExpression: soSearch.filterExpression,
                    matchCount: results.length,
                    matches: results.map((r) => ({
                        internalId: r.getValue({ name: 'internalid' }),
                        otherrefnum: r.getValue({ name: 'otherrefnum' })
                    }))
                });
                if (results.length > 1) {
                    log.error('Multiple Sales Orders share the same otherrefnum -- taking the first, but this is ambiguous', {
                        purchaseOrderId, matchCount: results.length
                    });
                }
                return results.length ? results[0].getValue({ name: 'internalid' }) : null;
            } catch (e) {
                log.error('Sales Order lookup by purchaseOrderId failed', { purchaseOrderId, errorMessage: e.message });
                return null;
            }
        }

        function findReturnRecord(externalId) {
            const returnSearch = search.create({
                type: RETURN_RECORD.TYPE,
                filters: [['externalidstring', 'is', externalId]],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: RETURN_RECORD.FIELDS.REVIEW_STATUS })
                ]
            });
            const results = returnSearch.run().getRange({ start: 0, end: 1 }) || [];
            if (!results.length) return null;

            return {
                id: results[0].getValue({ name: 'internalid' }),
                reviewStatus: results[0].getValue({ name: RETURN_RECORD.FIELDS.REVIEW_STATUS })
            };
        }

        function loadPreviousRawJson(recordId) {
            try {
                const existingRecord = record.load({ type: RETURN_RECORD.TYPE, id: recordId, isDynamic: false });
                return existingRecord.getValue({ fieldId: RETURN_RECORD.FIELDS.RAW_JSON });
            } catch (e) {
                log.error('Failed to load previous raw JSON for return record', { recordId, errorMessage: e.message });
                return null;
            }
        }

        /** Search-then-create, falling back to a re-search+update if a concurrent execution's create() wins the externalid race first. */
        function upsertReturnRecord(params) {
            const { returnOrderId, returnFields, rawJson } = params;
            const externalId = 'wal-return-' + returnOrderId;
            const salesOrderId = findSalesOrderByPurchaseOrderId(returnFields.purchaseOrderId);

            const fieldValues = {
                [RETURN_RECORD.FIELDS.RETURN_ORDER_ID]: String(returnOrderId),
                [RETURN_RECORD.FIELDS.PO_ID]: returnFields.purchaseOrderId,
                [RETURN_RECORD.FIELDS.RETURN_LINES]: returnFields.returnLines,
                [RETURN_RECORD.FIELDS.RETURN_STATUS]: returnFields.walmartStatus,
                [RETURN_RECORD.FIELDS.TRACKING_NUMBER]: returnFields.trackingNumber,
                [RETURN_RECORD.FIELDS.LABEL_URL]: returnFields.labelUrl,
                [RETURN_RECORD.FIELDS.RAW_JSON]: rawJson,
                [RETURN_RECORD.FIELDS.LAST_SYNCED]: new Date(),
                [RETURN_RECORD.FIELDS.DELIVERY_DATE]: returnFields.deliveryDate,
                // Always included (not just when a match is found) -- otherwise a
                // return that fails to match on one sync keeps whatever SALES_ORDER
                // value (right, wrong, or stale) an earlier sync left behind, forever.
                [RETURN_RECORD.FIELDS.SALES_ORDER]: salesOrderId || null,
                // A successful sync clears any error a prior failed sync left behind.
                [RETURN_RECORD.FIELDS.ERROR]: ''
            };

            const existing = findReturnRecord(externalId);
            if (existing) {
                const previousRawJson = loadPreviousRawJson(existing.id);
                record.submitFields({
                    type: RETURN_RECORD.TYPE,
                    id: existing.id,
                    values: fieldValues,
                    options: { enableSourcing: false, ignoreMandatoryFields: true }
                });
                log.audit('Return record updated', { returnOrderId, recordId: existing.id });
                return { id: existing.id, previousRawJson, previousReviewStatus: existing.reviewStatus };
            }

            try {
                const returnRecord = record.create({ type: RETURN_RECORD.TYPE, isDynamic: false });
                returnRecord.setValue({ fieldId: 'externalid', value: externalId });
                Object.keys(fieldValues).forEach((fieldId) => {
                    if (fieldValues[fieldId] != null) returnRecord.setValue({ fieldId, value: fieldValues[fieldId] });
                });
                returnRecord.setValue({ fieldId: RETURN_RECORD.FIELDS.REVIEW_STATUS, value: REVIEW_STATUS.PENDING_INSPECTION });

                const newId = returnRecord.save({ enableSourcing: false, ignoreMandatoryFields: true });
                log.audit('Return record created', { returnOrderId, recordId: newId });
                return { id: newId, previousRawJson: null, previousReviewStatus: null };
            } catch (createError) {
                const raceWinner = findReturnRecord(externalId);
                if (raceWinner) {
                    log.audit('Return record created by a concurrent execution, updating instead', {
                        returnOrderId, recordId: raceWinner.id
                    });
                    const previousRawJson = loadPreviousRawJson(raceWinner.id);
                    record.submitFields({
                        type: RETURN_RECORD.TYPE,
                        id: raceWinner.id,
                        values: fieldValues,
                        options: { enableSourcing: false, ignoreMandatoryFields: true }
                    });
                    return { id: raceWinner.id, previousRawJson, previousReviewStatus: raceWinner.reviewStatus };
                }
                throw createError;
            }
        }

        function findReturnLineRecord(externalId) {
            const lineSearch = search.create({
                type: RETURN_LINE_RECORD.TYPE,
                filters: [['externalidstring', 'is', externalId]],
                columns: [search.createColumn({ name: 'internalid' })]
            });
            const results = lineSearch.run().getRange({ start: 0, end: 1 }) || [];
            return results.length ? results[0].getValue({ name: 'internalid' }) : null;
        }

        /**
         * Upserts one customrecord_wal_return_line per returnOrderLine, by
         * externalid = 'wal-return-line-' + returnOrderId + '-' + lineNumber.
         * Only keeps sku/item_name/qty_requested/total_item_value current --
         * qty_approved, rejection_reason, and approved_item_value are reviewer-owned
         * and are never set or overwritten here, so a resync before review can't
         * clobber a decision already made.
         * Same search-then-create-with-race-fallback pattern as
         * upsertReturnRecord(); a per-line failure is logged and skipped rather
         * than failing the whole return's sync.
         */
        function upsertReturnLineRecords(params) {
            const { parentId, returnOrderId, lines } = params;

            lines.forEach((line) => {
                const externalId = `wal-return-line-${returnOrderId}-${line.lineNumber}`;
                const fieldValues = {
                    [RETURN_LINE_RECORD.FIELDS.PARENT]: parentId,
                    [RETURN_LINE_RECORD.FIELDS.LINE_NUMBER]: line.lineNumber,
                    [RETURN_LINE_RECORD.FIELDS.SKU]: line.sku,
                    [RETURN_LINE_RECORD.FIELDS.ITEM_NAME]: line.productName,
                    [RETURN_LINE_RECORD.FIELDS.QTY_REQUESTED]: line.qtyRequested,
                    [RETURN_LINE_RECORD.FIELDS.TOTAL_RETURN_VALUE]: line.totalItemValue
                };

                try {
                    const existingId = findReturnLineRecord(externalId);
                    if (existingId) {
                        record.submitFields({
                            type: RETURN_LINE_RECORD.TYPE,
                            id: existingId,
                            values: fieldValues,
                            options: { enableSourcing: false, ignoreMandatoryFields: true }
                        });
                        return;
                    }

                    const lineRecord = record.create({ type: RETURN_LINE_RECORD.TYPE, isDynamic: false });
                    lineRecord.setValue({ fieldId: 'externalid', value: externalId });
                    Object.keys(fieldValues).forEach((fieldId) => {
                        if (fieldValues[fieldId] != null) lineRecord.setValue({ fieldId, value: fieldValues[fieldId] });
                    });
                    lineRecord.save({ enableSourcing: false, ignoreMandatoryFields: true });
                } catch (createError) {
                    const raceWinnerId = findReturnLineRecord(externalId);
                    if (raceWinnerId) {
                        record.submitFields({
                            type: RETURN_LINE_RECORD.TYPE,
                            id: raceWinnerId,
                            values: fieldValues,
                            options: { enableSourcing: false, ignoreMandatoryFields: true }
                        });
                        return;
                    }
                    log.error('Failed to upsert return line record', {
                        returnOrderId, lineNumber: line.lineNumber, errorMessage: createError.message
                    });
                }
            });
        }

        return { getInputData, map, reduce };
    }
);
