/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * Ops tool for discarding shipping labels bought via wm_sl_order_shipment.js's
 * "Ship With Walmart" flow. Companion to that file's own flagged gap: if one
 * box in a multi-box order fails AFTER earlier boxes already had labels
 * bought, those earlier labels are real purchases that stay logged with a
 * real-label status on customrecord_wal_shipment_notification with no
 * automatic cleanup. This
 * Suitelet is the manual cleanup step, mirroring wm_sl_qbo_sync_retry.js's
 * checkbox-sublist pattern for a different recovery scenario.
 *
 * DELETE /v3/shipping/labels/carriers/{carrierShortName}/trackings/{trackingNo}
 * -- confirmed via developer.walmart.com/us-marketplace/reference/discardlabel:
 * no request body, response is { data: boolean, errors: [] }, data=true means
 * discarded successfully. Same path shape as wm_sl_order_shipment.js's
 * getLabelFile()/GET call, just DELETE instead of GET -- carrierShortName and
 * trackingNo are exactly the CARRIER/TRACKING values already stored on each
 * customrecord_wal_shipment_notification row (Walmart's own returned
 * carrierName, e.g. "FedEx"/"USPS"/"UPS" -- confirmed working for that same
 * GET call already, so trusted here too).
 *
 * Billing, per Walmart's own seller FAQ (not in the API reference docs):
 * the label is CHARGED when the order is marked Shipped (i.e. when
 * wm_sl_order_shipment.js's submitShippingConfirmation() call succeeds), not
 * at createLabel() time. So labels stuck at LABEL_CREATED (bought, but the
 * order's own shipment confirmation with Walmart never happened -- a
 * partial-batch failure) haven't actually been charged yet -- discarding them
 * here is pure cleanup, not a refund request. Discarding a label AFTER its
 * order was confirmed shipped (LABEL_CREATED_AND_SHIPPED) is also supported
 * and does refund an already-charged label, but slowly: 14-30 days for the
 * refund to post, 2-3 weeks for the credit/debit adjustment to show. This
 * Suitelet does not distinguish the two cases in code -- it shows each row's
 * Sales Order internal id so a human can tell which one they're in before
 * discarding, since the two only differ in whether money is actually moving
 * and how long that takes to resolve.
 *
 * STATUS values here match wm_sl_order_shipment.js's SHIP_NOTIFICATION_RECORD.STATUS
 * for the REAL-Walmart-label path only (LABEL_CREATED / LABEL_CREATED_AND_SHIPPED)
 * -- deliberately excludes that file's manual-tracking-path statuses
 * (TRACKING_SUBMITTED / TRACKING_SUBMITTED_AND_SHIPPED), since those rows never
 * had an actual Walmart-purchased label to discard (the carrier/tracking on
 * them was typed in by a human, not returned by Walmart's Create Label API) --
 * calling this Suitelet's DELETE against one of those would just fail against
 * Walmart with a not-found/invalid-tracking error.
 *
 * GET: lists every customrecord_wal_shipment_notification row currently at
 * LABEL_CREATED or LABEL_CREATED_AND_SHIPPED as a checkbox-selectable sublist
 * (PO#, SKU, carrier, tracking number, Sales Order, ship date).
 * POST: discards each selected row's label with Walmart, flips that row's
 * STATUS to "Discarded" on success, leaves its status untouched (with the new
 * error appended) on failure so it can be retried.
 *
 * Script parameters:
 *   custscript_wal_discard_label_client_id  - Walmart Marketplace API Client ID
 *   custscript_wal_discard_label_secret     - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_discard_label_env        - "PRODUCTION" or "SANDBOX"
 */
define(
    ['N/ui/serverWidget', 'N/record', 'N/search', 'N/runtime', 'N/https', 'N/encode', 'N/log', 'N/crypto/random', 'N/ui/message'],
    (serverWidget, record, search, runtime, https, encode, log, random, message) => {

        const SUBLIST_ID = 'custpage_labels';

        const BASE_URLS = {
            PRODUCTION: 'https://marketplace.walmartapis.com',
            SANDBOX: 'https://sandbox.walmartapis.com'
        };

        const PARAMS = {
            CLIENT_ID: 'custscript_wal_discard_label_client_id',
            CLIENT_SECRET: 'custscript_wal_discard_label_secret',
            ENVIRONMENT: 'custscript_wal_discard_label_env'
        };

        // Same record/fields wm_sl_order_shipment.js writes -- duplicated here rather
        // than shared, matching this project's existing convention (wm_sl_qbo_sync_retry.js
        // duplicates wm_mr_order_import.js's QBO logic the same way).
        const SHIP_NOTIFICATION_RECORD = {
            TYPE: 'customrecord_wal_shipping_notification',
            FIELDS: {
                PO_ID: 'custrecord_wal_shipnotif_po_id',
                SALES_ORDER: 'custrecord_wal_shipnotif_sales_order',
                STATUS: 'custrecord_wal_shipnotif_status',
                ERROR: 'custrecord_wal_shipnotif_error',
                TRACKING: 'custrecord_wal_shipnotif_tracking',
                CARRIER: 'custrecord_wal_shipnotif_carrier',
                SKU: 'custrecord_wal_shipnotif_sku',
                SHIP_DATE: 'custrecord_wal_shipnotif_ship_date'
            },
            STATUS: {
                // Real-Walmart-label-path statuses only -- see header comment. Matches
                // wm_sl_order_shipment.js's SHIP_NOTIFICATION_RECORD.STATUS text exactly;
                // deliberately excludes that file's TRACKING_SUBMITTED/_AND_SHIPPED values
                // (manual-tracking path, never had a real Walmart label to discard).
                LABEL_CREATED: 'Label created',
                LABEL_CREATED_AND_SHIPPED: 'Label created, shipping confirmed with Walmart',
                ERROR: 'Error',
                DISCARDED: 'Discarded' // new value -- STATUS is Free-Form Text, no NetSuite list update needed
            }
        };

        function onRequest(context) {
            if (context.request.method === 'GET') {
                renderForm(context);
            } else {
                handleDiscard(context);
            }
        }

        // ---------------------------------------------------------------
        // GET: list every real-Walmart-label shipment-notification row as a checkbox-selectable row
        // ---------------------------------------------------------------

        function renderForm(context) {
            const form = serverWidget.createForm({ title: 'Discard Walmart Shipping Labels' });
            form.addSubmitButton({ label: 'Discard Selected' });

            const resultParam = context.request.parameters.custpage_result;
            if (resultParam) {
                form.addPageInitMessage({ type: message.Type.CONFIRMATION, title: 'Result', message: resultParam });
            }

            const rows = findDiscardableNotifications();

            const sublist = form.addSublist({ id: SUBLIST_ID, type: serverWidget.SublistType.LIST, label: 'Labels (Bought via Walmart, not yet discarded)' });
            sublist.addField({ id: 'select', type: serverWidget.FieldType.CHECKBOX, label: 'Discard' });
            sublist.addField({ id: 'poid', type: serverWidget.FieldType.TEXT, label: 'Walmart PO ID' });
            sublist.addField({ id: 'sku', type: serverWidget.FieldType.TEXT, label: 'SKU' });
            sublist.addField({ id: 'carrier', type: serverWidget.FieldType.TEXT, label: 'Carrier' });
            sublist.addField({ id: 'tracking', type: serverWidget.FieldType.TEXT, label: 'Tracking Number' });
            sublist.addField({ id: 'salesorder', type: serverWidget.FieldType.TEXT, label: 'Sales Order (check its status before discarding)' });
            sublist.addField({ id: 'shipdate', type: serverWidget.FieldType.TEXT, label: 'Ship Date' });
            sublist.addField({ id: 'notifid', type: serverWidget.FieldType.TEXT, label: 'Notification Record Id' })
                .updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });

            rows.forEach((row, line) => {
                // setSublistValue throws SSS_MISSING_REQD_ARGUMENT on an empty string for
                // ANY sublist field, not just hidden ones -- every fallback below must be
                // a non-empty placeholder, never ''.
                sublist.setSublistValue({ id: 'select', line, value: 'F' });
                sublist.setSublistValue({ id: 'poid', line, value: row.poId || '(unknown)' });
                sublist.setSublistValue({ id: 'sku', line, value: row.sku || '(none)' });
                sublist.setSublistValue({ id: 'carrier', line, value: row.carrier || '(none)' });
                sublist.setSublistValue({ id: 'tracking', line, value: row.tracking || '(none)' });
                sublist.setSublistValue({ id: 'salesorder', line, value: row.salesOrderId ? String(row.salesOrderId) : '(none)' });
                sublist.setSublistValue({ id: 'shipdate', line, value: row.shipDate || '(none)' });
                sublist.setSublistValue({ id: 'notifid', line, value: String(row.id) });
            });

            context.response.writePage(form);
        }

        function findDiscardableNotifications() {
            const notifSearch = search.create({
                type: SHIP_NOTIFICATION_RECORD.TYPE,
                // 'is' OR'd across both real-Walmart-label statuses -- STATUS is Free-Form
                // Text, so this is the OR-two-sub-filters form rather than 'anyof' (that
                // operator is for List/Record fields). Deliberately excludes the
                // manual-tracking-path statuses -- see header comment.
                filters: [
                    [SHIP_NOTIFICATION_RECORD.FIELDS.STATUS, 'is', SHIP_NOTIFICATION_RECORD.STATUS.LABEL_CREATED],
                    'or',
                    [SHIP_NOTIFICATION_RECORD.FIELDS.STATUS, 'is', SHIP_NOTIFICATION_RECORD.STATUS.LABEL_CREATED_AND_SHIPPED]
                ],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: SHIP_NOTIFICATION_RECORD.FIELDS.PO_ID }),
                    search.createColumn({ name: SHIP_NOTIFICATION_RECORD.FIELDS.SKU }),
                    search.createColumn({ name: SHIP_NOTIFICATION_RECORD.FIELDS.CARRIER }),
                    search.createColumn({ name: SHIP_NOTIFICATION_RECORD.FIELDS.TRACKING }),
                    search.createColumn({ name: SHIP_NOTIFICATION_RECORD.FIELDS.SALES_ORDER }),
                    search.createColumn({ name: SHIP_NOTIFICATION_RECORD.FIELDS.SHIP_DATE })
                ]
            });

            const rows = [];
            notifSearch.run().each((result) => {
                rows.push({
                    id: result.getValue({ name: 'internalid' }),
                    poId: result.getValue({ name: SHIP_NOTIFICATION_RECORD.FIELDS.PO_ID }),
                    sku: result.getValue({ name: SHIP_NOTIFICATION_RECORD.FIELDS.SKU }),
                    carrier: result.getValue({ name: SHIP_NOTIFICATION_RECORD.FIELDS.CARRIER }),
                    tracking: result.getValue({ name: SHIP_NOTIFICATION_RECORD.FIELDS.TRACKING }),
                    salesOrderId: result.getValue({ name: SHIP_NOTIFICATION_RECORD.FIELDS.SALES_ORDER }),
                    shipDate: result.getValue({ name: SHIP_NOTIFICATION_RECORD.FIELDS.SHIP_DATE })
                });
                return true;
            });
            return rows;
        }

        // ---------------------------------------------------------------
        // POST: discard each selected row's label with Walmart
        // ---------------------------------------------------------------

        function handleDiscard(context) {
            const request = context.request;
            const lineCount = request.getLineCount({ group: SUBLIST_ID });

            const selectedRows = [];
            for (let line = 0; line < lineCount; line++) {
                const selected = request.getSublistValue({ group: SUBLIST_ID, name: 'select', line });
                if (selected !== 'T') continue;
                selectedRows.push({
                    notifId: request.getSublistValue({ group: SUBLIST_ID, name: 'notifid', line }),
                    carrier: request.getSublistValue({ group: SUBLIST_ID, name: 'carrier', line }),
                    tracking: request.getSublistValue({ group: SUBLIST_ID, name: 'tracking', line }),
                    poId: request.getSublistValue({ group: SUBLIST_ID, name: 'poid', line })
                });
            }

            if (!selectedRows.length) {
                redirectWithResult(context, 'No rows selected -- nothing discarded.');
                return;
            }

            const ctx = getScriptParams();
            const baseUrl = BASE_URLS[ctx.environment] || BASE_URLS.SANDBOX;

            let succeeded = 0;
            let failed = 0;
            for (const row of selectedRows) {
                const correlationId = random.generateUUID();
                try {
                    const accessToken = getWalmartAccessToken({ clientId: ctx.clientId, clientSecret: ctx.clientSecret, baseUrl, correlationId });
                    discardLabel({
                        accessToken, baseUrl, correlationId, environment: ctx.environment,
                        carrierShortName: row.carrier, trackingNo: row.tracking
                    });

                    record.submitFields({
                        type: SHIP_NOTIFICATION_RECORD.TYPE, id: row.notifId,
                        values: { [SHIP_NOTIFICATION_RECORD.FIELDS.STATUS]: SHIP_NOTIFICATION_RECORD.STATUS.DISCARDED },
                        options: { enableSourcing: false, ignoreMandatoryFields: true }
                    });
                    succeeded++;
                } catch (e) {
                    log.error('Failed to discard label', {
                        notifId: row.notifId, poId: row.poId, carrier: row.carrier, tracking: row.tracking,
                        errorName: e && e.name, errorMessage: e && e.message
                    });
                    // Leave STATUS as whatever it already was (still a real, undiscarded
                    // label) -- append the failure to ERROR so it's visible without blocking
                    // a later retry attempt.
                    record.submitFields({
                        type: SHIP_NOTIFICATION_RECORD.TYPE, id: row.notifId,
                        values: { [SHIP_NOTIFICATION_RECORD.FIELDS.ERROR]: String(e && e.message).substring(0, 1000) },
                        options: { enableSourcing: false, ignoreMandatoryFields: true }
                    });
                    failed++;
                }
            }

            redirectWithResult(context, `Discarded ${succeeded} label(s).` + (failed ? ` ${failed} failed -- see execution log, still available above for retry.` : ''));
        }

        function redirectWithResult(context, resultMessage) {
            // GET-with-query-param redirect (matching wm_sl_qbo_sync_retry.js's own pattern)
            // rather than writing the form directly from the POST handler -- avoids a
            // browser re-POST warning if the page is refreshed afterward.
            const script = runtime.getCurrentScript();
            context.response.sendRedirect({
                type: 'suitelet',
                identifier: script.id,
                id: script.deploymentId,
                parameters: { custpage_result: resultMessage }
            });
        }

        function discardLabel(params) {
            const { accessToken, baseUrl, correlationId, environment, carrierShortName, trackingNo } = params;

            const response = https.delete({
                url: `${baseUrl}/v3/shipping/labels/carriers/${encodeURIComponent(carrierShortName)}/trackings/${encodeURIComponent(trackingNo)}`,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'WM_QOS.CORRELATION_ID': correlationId,
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'WM_MARKET': 'us',
                    'Accept': 'application/json'
                }
            });

            logHttpResponse(`Walmart discard label request (carrier=${carrierShortName}, trackingNo=${trackingNo})`, response, correlationId);
            if (response.code !== 200) {
                throw new Error(`Walmart discard label request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }
            const parsed = safeJsonParse(response.body, correlationId, 'discard label');
            // Confirmed live against the sandbox stub: data comes back as the STRING
            // "true", not boolean true, despite the docs describing it as a boolean.
            if (parsed.data !== true && parsed.data !== 'true') {
                throw new Error(`Walmart discard label did not confirm success (correlationId=${correlationId}): ${response.body}`);
            }
            return parsed;
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

        /** JSON.parse that logs the raw body before throwing -- same convention as the other Walmart scripts in this project. */
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
