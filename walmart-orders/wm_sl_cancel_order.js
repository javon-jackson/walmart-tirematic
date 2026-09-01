/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * Ops tool for cancelling a Walmart order (in full or by line/quantity) through
 * Walmart's Cancel Order Lines API -- POST /v3/orders/{purchaseOrderId}/cancel.
 *
 * Two-step flow:
 *   STEP 1 (LOOKUP): user enters a Walmart purchaseOrderId. This looks up the
 *     matching customrecord_wal_order_import_lock row (same authoritative "is this
 *     really a Walmart order" check every other tool in this folder uses) to get the
 *     Sales Order, fetches the order fresh from Walmart, and renders one row per
 *     order line still eligible for cancellation -- see getCancellableLines()'s
 *     comment on how "still eligible" is determined. Lines already fully shipped or
 *     cancelled are left off the form entirely. Each remaining line gets a "Quantity
 *     to Cancel" field pre-filled to its full remaining quantity (editable down for a
 *     partial-quantity cancel; leaving it at 0 drops the line from the request), plus ONE
 *     order-wide Cancellation Reason select. If you need to select different cancellation 
 *     reasons for orderlines, set a quantity only for the lines you wish to cancel for that reason.
 *   STEP 2 (CANCEL): user picks a reason and submits. Re-fetches the order and
 *     regenerates the same cancellable-line list fresh -- nothing from step 1 is
 *     trusted to still be current. Lines are matched back up by lineNumber. 
 *     If a requested line's remaining quantity dropped below what was asked 
 *     (e.g. it shipped in the meantime) or the line is no longer eligible at all, 
 *     this throws. POSTs the cancellation to Walmart in ONE call
 *     covering every selected line, logs one customrecord_wal_order_cancellation row
 *     per line, and shows the result.
 *
 *
 * TODO:
 *   - getCancellableLines() treats orderLineStatuses entries with status "Created" OR
 *     "Acknowledged" as still-cancellable quantity on a line. wm_mr_order_import.js acknowledges every
 *     order right after import, which flips each line to "Acknowledged" on Walmart's
 *     side, so by the time an order reaches this tool it's almost always past
 *     "Created". Still unconfirmed whether Walmart ever reports some other pre-ship
 *     status value that should also count as still-cancellable. If a real order shows
 *     a line that looks cancellable in Walmart's own Seller Center but doesn't appear
 *     on this tool's form, check that line's real orderLineStatuses values first
 *     before assuming this tool is broken.
 *
 * Script parameters:
 *   custscript_wal_cancel_order_client_id  - Walmart Marketplace API Client ID
 *   custscript_wal_cancel_order_secret     - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_cancel_order_env        - "PRODUCTION" or "SANDBOX"
 */
define(
    ['N/record', 'N/search', 'N/runtime', 'N/https', 'N/encode', 'N/log', 'N/crypto/random', 'N/ui/serverWidget', 'N/ui/message', 'N/url'],
    (record, search, runtime, https, encode, log, random, serverWidget, message, url) => {

        const BASE_URLS = {
            PRODUCTION: 'https://marketplace.walmartapis.com',
            SANDBOX: 'https://sandbox.walmartapis.com'
        };

        const BUTTON_STYLE = 'display:inline-block;padding:10px 20px;background:#187bf2;color:#fff;'
            + 'font-weight:bold;font-size:14px;text-decoration:none;border-radius:3px;border:none;cursor:pointer;';

        const PARAMS = {
            CLIENT_ID: 'custscript_wal_cancel_order_client_id',
            CLIENT_SECRET: 'custscript_wal_cancel_order_secret',
            ENVIRONMENT: 'custscript_wal_cancel_order_env'
        };

        // https://developer.walmart.com/us-marketplace/reference/cancelorderlines
        const CANCELLATION_REASONS = {
            CUSTOMER_REQUESTED_SELLER_TO_CANCEL: 'Customer requested cancellation',
            SELLER_CANCEL_PRICING_ERROR: 'Pricing error',
            SELLER_CANCEL_OUT_OF_STOCK: 'Out of stock',
            SELLER_CANCEL_FRAUD_STOP_SHIPMENT: 'Suspected fraud / stop shipment',
            SELLER_CANCEL_ADDRESS_NOT_SERVICEABLE: 'Address not serviceable'
        };

        const LOCK_RECORD_TYPE = 'customrecord_wal_order_import_lock';
        const LOCK_FIELDS = {
            SALES_ORDER: 'custrecord_wal_lock_sales_order',
            PO_ID: 'custrecord_wal_lock_po_id'
        };

        const CANCELLATION_RECORD = {
            TYPE: 'customrecord_wal_order_cancellation',
            FIELDS: {
                PO_ID: 'custrecord_wal_cancel_po_id',
                SALES_ORDER: 'custrecord_wal_cancel_sales_order',
                STATUS: 'custrecord_wal_cancel_status',
                ERROR: 'custrecord_wal_cancel_error',
                CORRELATION: 'custrecord_wal_cancel_correlation_id',
                LINE_NUMBER: 'custrecord_wal_cancel_order_line_number',
                SKU: 'custrecord_wal_cancel_sku',
                ITEM_NAME: 'custrecord_wal_cancel_item_name',
                QUANTITY: 'custrecord_wal_cancel_quantity',
                REASON: 'custrecord_wal_cancel_reason',
                CANCEL_DATE: 'custrecord_wal_cancel_date'
            },
            STATUS: {
                CONFIRMED: 'Confirmed',
                ERROR: 'Error'
            }
        };

        const ACTION = {
            LOOKUP: 'lookup',
            CANCEL: 'cancel'
        };

        function onRequest(context) {
            const request = context.request;
            const action = request.parameters.custpage_action;

            try {
                if (request.method !== 'POST') {
                    context.response.writePage(buildLookupForm());
                    return;
                }

                if (action === ACTION.LOOKUP) {
                    handleLookup(context);
                } else if (action === ACTION.CANCEL) {
                    handleCancel(context);
                } else {
                    context.response.writePage(buildLookupForm('Unknown action -- please start again.'));
                }
            } catch (e) {
                log.error('Order cancellation - unhandled error', {
                    action, errorName: e && e.name, errorMessage: e && e.message
                });
                context.response.writePage(buildResultPage({ success: false, message: e && e.message, correlationId: null }));
            }
        }

        function buildLookupForm(errorMessage) {
            const form = serverWidget.createForm({ title: 'Cancel Walmart Order' });
            if (errorMessage) {
                form.addPageInitMessage({ type: message.Type.ERROR, title: 'Error', message: errorMessage });
            }
            const group = addSingleColumnGroup(form, 'custpage_lookup_group');

            const poField = form.addField({
                id: 'custpage_po_id', type: serverWidget.FieldType.TEXT, label: 'Walmart Purchase Order ID', container: group
            });
            poField.isMandatory = true;

            form.addSubmitButton({ label: 'Look Up Order' });
            const actionField = form.addField({
                id: 'custpage_action', type: serverWidget.FieldType.TEXT, label: 'Action', container: group
            });
            actionField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            actionField.defaultValue = ACTION.LOOKUP;
            return form;
        }

        /** STEP 1: look up the order, find lines still eligible for cancellation, render a form to pick quantities/reason. */
        function handleLookup(context) {
            const purchaseOrderId = context.request.parameters.custpage_po_id;
            if (!purchaseOrderId) {
                context.response.writePage(buildLookupForm('Enter a Walmart Purchase Order ID.'));
                return;
            }

            const lock = findWalmartLockByPoId(purchaseOrderId);
            if (!lock) {
                context.response.writePage(buildLookupForm(`No Walmart import record found for purchaseOrderId "${purchaseOrderId}" -- confirm this order was actually imported.`));
                return;
            }

            const ctx = getScriptParams();
            const baseUrl = BASE_URLS[ctx.environment] || BASE_URLS.SANDBOX;
            const correlationId = random.generateUUID();
            const accessToken = getWalmartAccessToken({ clientId: ctx.clientId, clientSecret: ctx.clientSecret, baseUrl, correlationId });

            const orderDetails = getOrderDetails({ accessToken, baseUrl, purchaseOrderId, correlationId, environment: ctx.environment });
            const lines = getCancellableLines(orderDetails);
            if (!lines.length) {
                context.response.writePage(buildLookupForm(`Walmart order "${purchaseOrderId}" has no lines eligible for cancellation -- every line is already fully shipped or cancelled.`));
                return;
            }

            context.response.writePage(buildCancelForm({ purchaseOrderId, salesOrderId: lock.salesOrderId, lines }));
        }

        function buildCancelForm(params) {
            const { purchaseOrderId, salesOrderId, lines } = params;
            const form = serverWidget.createForm({ title: 'Choose Lines/Quantities to Cancel' });
            const group = addSingleColumnGroup(form, 'custpage_cancel_group');

            const poField = form.addField({ id: 'custpage_po_id', type: serverWidget.FieldType.TEXT, label: 'Walmart Purchase Order ID', container: group });
            poField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
            poField.defaultValue = purchaseOrderId;

            const soField = form.addField({ id: 'custpage_sales_order_id', type: serverWidget.FieldType.TEXT, label: 'Sales Order Internal ID', container: group });
            soField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
            soField.defaultValue = String(salesOrderId);

            const actionField = form.addField({ id: 'custpage_action', type: serverWidget.FieldType.TEXT, label: 'Action', container: group });
            actionField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            actionField.defaultValue = ACTION.CANCEL;

            // Step 2 regenerates the same cancellable-line list fresh and matches
            // requested quantities back up by lineNumber (carried here as a hidden
            // field per row).
            const countField = form.addField({ id: 'custpage_line_count', type: serverWidget.FieldType.TEXT, label: 'Line Count', container: group });
            countField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            countField.defaultValue = String(lines.length);

            lines.forEach((line, index) => {
                const numberField = form.addField({ id: 'custpage_line_' + index + '_number', type: serverWidget.FieldType.TEXT, label: 'Line Number', container: group });
                numberField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
                numberField.defaultValue = String(line.lineNumber);

                const skuField = form.addField({ id: 'custpage_line_' + index + '_sku', type: serverWidget.FieldType.TEXT, label: 'SKU', container: group });
                skuField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
                skuField.defaultValue = line.sku || '';

                const nameField = form.addField({ id: 'custpage_line_' + index + '_name', type: serverWidget.FieldType.TEXT, label: 'Item Name', container: group });
                nameField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
                nameField.defaultValue = line.productName || '';

                const qtyField = form.addField({
                    id: 'custpage_line_' + index + '_qty', type: serverWidget.FieldType.INTEGER,
                    label: `${line.productName || line.sku} (${line.sku}) - Quantity to Cancel (of ${line.cancellableQty} still cancellable)`,
                    container: group
                });
                qtyField.defaultValue = String(line.cancellableQty);
            });

            const reasonField = form.addField({ id: 'custpage_reason', type: serverWidget.FieldType.SELECT, label: 'Cancellation Reason', container: group });
            reasonField.isMandatory = true;
            // Walmart doesn't surface a customer's cancellation request as any kind of
            // flag or event on the order itself -- it only reaches a seller as an email/
            // Seller Center Notification Center alert (48-hour window to act before
            // Walmart auto-cancels). This tool has no way to detect that on its own, so
            // the reminder here is for whoever is picking a reason by hand.
            reasonField.setHelpText({
                help: 'Pick "Customer requested cancellation" only if Walmart actually notified you of a customer cancellation request '
                    + '(email or Seller Center Notification Center) -- this tool cannot detect that on its own. Otherwise pick the reason that matches why YOU are cancelling.'
            });
            reasonField.addSelectOption({ value: '', text: '-- Select a Reason --', isSelected: true });
            Object.keys(CANCELLATION_REASONS).forEach((key) => {
                reasonField.addSelectOption({ value: key, text: CANCELLATION_REASONS[key] });
            });

            form.addSubmitButton({ label: 'Cancel Selected Lines with Walmart' });

            const startOverField = form.addField({ id: 'custpage_start_over', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
            startOverField.defaultValue = '<div style="padding:10px 0;">'
                + `<a href="${buildSuiteletUrl()}" style="${BUTTON_STYLE}">Start over</a>`
                + '</div>';

            return form;
        }

        /** STEP 2: re-fetch, validate requested quantities are still available, cancel with Walmart in one call, log per line. */
        function handleCancel(context) {
            const request = context.request;
            const purchaseOrderId = request.parameters.custpage_po_id;
            const salesOrderId = request.parameters.custpage_sales_order_id;
            const lineCount = Number(request.parameters.custpage_line_count) || 0;
            const reason = request.parameters.custpage_reason;

            if (!purchaseOrderId || !salesOrderId || !lineCount) {
                context.response.writePage(buildResultPage({ success: false, message: 'Missing purchaseOrderId, Sales Order id, or line entries -- please start again.' }));
                return;
            }
            if (!CANCELLATION_REASONS[reason]) {
                context.response.writePage(buildResultPage({ success: false, message: 'Select a valid cancellation reason -- please start again.' }));
                return;
            }

            const requestedLines = [];
            for (let i = 0; i < lineCount; i++) {
                const qty = Number(request.parameters['custpage_line_' + i + '_qty']) || 0;
                if (qty <= 0) continue;
                requestedLines.push({
                    lineNumber: String(request.parameters['custpage_line_' + i + '_number'] || ''),
                    sku: request.parameters['custpage_line_' + i + '_sku'] || '',
                    productName: request.parameters['custpage_line_' + i + '_name'] || '',
                    qty
                });
            }
            if (!requestedLines.length) {
                context.response.writePage(buildResultPage({ success: false, message: 'Enter a quantity greater than 0 for at least one line -- please start again.' }));
                return;
            }

            const ctx = getScriptParams();
            const baseUrl = BASE_URLS[ctx.environment] || BASE_URLS.SANDBOX;
            const correlationId = random.generateUUID();
            const cancelDate = new Date();

            try {
                const accessToken = getWalmartAccessToken({ clientId: ctx.clientId, clientSecret: ctx.clientSecret, baseUrl, correlationId });

                // Re-fetch fresh and regenerate the same cancellable-line list step 1
                // built -- nothing trusted to still be current except which lineNumber/
                // quantity the user picked.
                const orderDetails = getOrderDetails({ accessToken, baseUrl, purchaseOrderId, correlationId, environment: ctx.environment });
                const currentLines = getCancellableLines(orderDetails);
                const currentByLineNumber = {};
                currentLines.forEach((line) => { currentByLineNumber[line.lineNumber] = line; });

                for (const requested of requestedLines) {
                    const current = currentByLineNumber[requested.lineNumber];
                    if (!current) {
                        throw new Error(`Line ${requested.lineNumber} (${requested.sku}) is no longer eligible for cancellation -- it may have already shipped or been cancelled since this form was opened. Please start again.`);
                    }
                    if (requested.qty > current.cancellableQty) {
                        throw new Error(`Line ${requested.lineNumber} (${requested.sku}) only has ${current.cancellableQty} unit(s) left to cancel now (requested ${requested.qty}) -- the order may have changed since this form was opened. Please start again.`);
                    }
                }

                const payload = buildCancellationPayload({ requestedLines, reason });
                submitOrderCancellation({ accessToken, baseUrl, purchaseOrderId, correlationId, environment: ctx.environment, payload });

                requestedLines.forEach((requested) => {
                    recordCancellation({
                        purchaseOrderId, salesOrderId, status: CANCELLATION_RECORD.STATUS.CONFIRMED,
                        lineNumber: requested.lineNumber, sku: requested.sku, itemName: requested.productName,
                        quantity: requested.qty, reason, correlationId, cancelDate
                    });
                });

                const lineSummary = requestedLines.map((r) => `${r.sku} x${r.qty}`).join(', ');
                context.response.writePage(buildResultPage({
                    success: true,
                    message: `Cancellation confirmed with Walmart for ${requestedLines.length} line(s): ${lineSummary}.`,
                    correlationId
                }));
            } catch (e) {
                log.error('Order cancellation - failed to cancel order', {
                    purchaseOrderId, salesOrderId, errorName: e && e.name, errorMessage: e && e.message
                });
                requestedLines.forEach((requested) => {
                    recordCancellation({
                        purchaseOrderId, salesOrderId, status: CANCELLATION_RECORD.STATUS.ERROR, errorMessage: e && e.message,
                        lineNumber: requested.lineNumber, sku: requested.sku, itemName: requested.productName,
                        quantity: requested.qty, reason, correlationId, cancelDate
                    });
                });
                context.response.writePage(buildResultPage({ success: false, message: e && e.message, correlationId }));
            }
        }

        function buildResultPage(params) {
            const { success, message, correlationId } = params;
            const form = serverWidget.createForm({ title: success ? 'Cancellation Confirmed' : 'Cancellation Failed' });
            const text = [
                success ? 'Success.' : 'Error.',
                message,
                correlationId ? `\n\ncorrelationId: ${correlationId} (reference this if you need to ask Walmart support about this order)` : ''
            ].filter(Boolean).join(' ');

            const resultField = form.addField({ id: 'custpage_result', type: serverWidget.FieldType.LONGTEXT, label: 'Result' });
            resultField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
            resultField.defaultValue = text;

            const nextField = form.addField({ id: 'custpage_next', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
            nextField.defaultValue = '<div style="padding:10px 0;">'
                + `<a href="${buildSuiteletUrl()}" style="${BUTTON_STYLE}">Cancel another order</a>`
                + '</div>';

            return form;
        }

        /** This Suitelet's own URL -- shared by every "start over" link so the runtime/url calls aren't repeated at each spot. */
        function buildSuiteletUrl(params) {
            const script = runtime.getCurrentScript();
            return url.resolveScript({
                scriptId: script.id, deploymentId: script.deploymentId, returnExternalUrl: false,
                params: params || {}
            });
        }

        /** Stacks every field assigned to it in one column instead of NetSuite's default two-column layout -- same helper as wm_sl_order_shipment.js. */
        function addSingleColumnGroup(form, id) {
            const group = form.addFieldGroup({ id, label: ' ' });
            group.isSingleColumn = true;
            return id;
        }

        /** Same authoritative "is this a Walmart order" check as the other tools in this folder, keyed by PO id since that's what the user enters here. */
        function findWalmartLockByPoId(purchaseOrderId) {
            const lockSearch = search.create({
                type: LOCK_RECORD_TYPE,
                filters: [[LOCK_FIELDS.PO_ID, 'is', String(purchaseOrderId)]],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: LOCK_FIELDS.SALES_ORDER })
                ]
            });
            const results = lockSearch.run().getRange({ start: 0, end: 1 }) || [];
            if (!results.length) return null;

            return {
                id: results[0].getValue({ name: 'internalid' }),
                salesOrderId: results[0].getValue({ name: LOCK_FIELDS.SALES_ORDER })
            };
        }

        /**
         * A line counts as cancellable only for the portion of its quantity still
         * sitting in Walmart's "Created" or "Acknowledged" orderLineStatus -- quantity
         * already reported under any other status (e.g. "Shipped", "Cancelled") is
         * excluded. Both statuses have to count: wm_mr_order_import.js acknowledges
         * every order right after import (POST .../acknowledge), and Walmart echoes
         * that back as each line's status flipping from "Created" to "Acknowledged" --
         * by the time an order reaches this tool it has virtually always already made
         * that transition, so "Created" alone would show 0 cancellable lines on almost
         * every real order. Lines with 0 cancellable quantity are left out of
         * the returned list entirely.
         */
        function getCancellableLines(orderDetails) {
            const orderLines = (orderDetails.orderLines && orderDetails.orderLines.orderLine) || [];
            const lines = [];

            for (const line of orderLines) {
                const lineNumber = String(line.lineNumber);
                const sku = line.item && line.item.sku;
                const productName = line.item && line.item.productName;
                const totalQty = Number(line.orderLineQuantity && line.orderLineQuantity.amount) || 0;
                const statuses = (line.orderLineStatuses && line.orderLineStatuses.orderLineStatus) || [];
                const cancellableQty = statuses
                    .filter((s) => s.status === 'Created' || s.status === 'Acknowledged')
                    .reduce((sum, s) => sum + (Number(s.statusQuantity && s.statusQuantity.amount) || 0), 0);

                if (cancellableQty <= 0) continue;
                lines.push({ lineNumber, sku, productName, totalQty, cancellableQty });
            }

            return lines;
        }

        /**
         * One orderLineStatus entry per requested line, each carrying the SAME
         * cancellationReason and that line's own requested statusQuantity.
         */
        function buildCancellationPayload(params) {
            const { requestedLines, reason } = params;
            const orderLine = requestedLines.map((requested) => ({
                lineNumber: requested.lineNumber,
                orderLineStatuses: {
                    orderLineStatus: [{
                        status: 'Cancelled',
                        cancellationReason: reason,
                        statusQuantity: { unitOfMeasurement: 'EACH', amount: String(requested.qty) }
                    }]
                }
            }));
            return { orderCancellation: { orderLines: { orderLine } } };
        }

        function submitOrderCancellation(params) {
            const { accessToken, baseUrl, purchaseOrderId, correlationId, environment, payload } = params;

            const requestBody = JSON.stringify(payload);
            log.audit(`Walmart order cancellation request body (purchaseOrderId=${purchaseOrderId}, correlationId=${correlationId})`, requestBody);

            const response = https.post({
                url: `${baseUrl}/v3/orders/${encodeURIComponent(purchaseOrderId)}/cancel`,
                body: requestBody,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'WM_QOS.CORRELATION_ID': correlationId,
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            logHttpResponse(`Walmart order cancellation request (purchaseOrderId=${purchaseOrderId})`, response, correlationId);
            if (response.code !== 200) {
                throw new Error(`Walmart order cancellation failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }
            return safeJsonParse(response.body, correlationId, 'order cancellation');
        }

        function getOrderDetails(params) {
            const { accessToken, baseUrl, purchaseOrderId, correlationId, environment } = params;

            const response = https.get({
                url: `${baseUrl}/v3/orders/${encodeURIComponent(purchaseOrderId)}`,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'WM_QOS.CORRELATION_ID': correlationId,
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'Accept': 'application/json'
                }
            });

            logHttpResponse(`Walmart order details request (purchaseOrderId=${purchaseOrderId})`, response, correlationId);
            if (response.code !== 200) {
                throw new Error(`Walmart order details request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }

            const parsed = safeJsonParse(response.body, correlationId, 'order details');
            if (!parsed.order) {
                throw new Error(`Walmart order details response missing "order" wrapper (correlationId=${correlationId}): ${response.body}`);
            }
            return parsed.order;
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

        function recordCancellation(params) {
            const {
                purchaseOrderId, salesOrderId, status, errorMessage, lineNumber, sku, itemName,
                quantity, reason, correlationId, cancelDate
            } = params;
            try {
                const cancelRecord = record.create({ type: CANCELLATION_RECORD.TYPE, isDynamic: false });
                cancelRecord.setValue({ fieldId: CANCELLATION_RECORD.FIELDS.PO_ID, value: String(purchaseOrderId) });
                cancelRecord.setValue({ fieldId: CANCELLATION_RECORD.FIELDS.SALES_ORDER, value: salesOrderId });
                cancelRecord.setValue({ fieldId: CANCELLATION_RECORD.FIELDS.STATUS, value: status });
                if (lineNumber) cancelRecord.setValue({ fieldId: CANCELLATION_RECORD.FIELDS.LINE_NUMBER, value: String(lineNumber) });
                if (sku) cancelRecord.setValue({ fieldId: CANCELLATION_RECORD.FIELDS.SKU, value: sku });
                if (itemName) cancelRecord.setValue({ fieldId: CANCELLATION_RECORD.FIELDS.ITEM_NAME, value: itemName });
                if (quantity != null) cancelRecord.setValue({ fieldId: CANCELLATION_RECORD.FIELDS.QUANTITY, value: quantity });
                if (reason) cancelRecord.setValue({ fieldId: CANCELLATION_RECORD.FIELDS.REASON, value: reason });
                if (correlationId) cancelRecord.setValue({ fieldId: CANCELLATION_RECORD.FIELDS.CORRELATION, value: correlationId });
                if (cancelDate) cancelRecord.setValue({ fieldId: CANCELLATION_RECORD.FIELDS.CANCEL_DATE, value: cancelDate });
                if (errorMessage) cancelRecord.setValue({ fieldId: CANCELLATION_RECORD.FIELDS.ERROR, value: String(errorMessage).substring(0, 1000) });
                cancelRecord.save({ enableSourcing: false, ignoreMandatoryFields: true });
            } catch (recordError) {
                log.error('Order cancellation - failed to write cancellation record', {
                    purchaseOrderId, salesOrderId, lineNumber, errorMessage: recordError && recordError.message
                });
            }
        }

        /** JSON.parse that logs the raw body before throwing */
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
