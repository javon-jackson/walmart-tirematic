/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * Ops-facing recovery tool for customscript_wal_order_import_mr (wm_mr_order_import.js) 
 * reduce() failures.
 *
 * Background: when reduce() successfully creates the NetSuite Sales Order but
 * then fails to sync it to QuickBooks Online (bad/expired token, missing QBO
 * customer/vendor/item, etc.), it sets the order's lock record
 * (customrecord_wal_order_import_lock) to status "Review Required" and NEVER
 * releases it -- releasing would let the hourly reconciliation scan create a
 * second, duplicate Sales Order just because QBO sync failed. But nothing
 * automatically retries the QBO half after that, since map() unconditionally
 * skips any purchaseOrderId that already has a lock, regardless of status.
 * This Suitelet is that missing retry step, run by a human.
 *
 * GET: lists every lock currently in "Review Required" as a checkbox-selectable
 * sublist (Walmart PO id, NetSuite Sales Order, last error).
 *
 * POST: re-fetches each selected order fresh from Walmart by purchaseOrderId
 * (the lock doesn't store the original orderDetails, only the PO id and the
 * NetSuite Sales Order it produced), then re-runs acknowledgeOrder() followed
 * by the exact same createQboInvoice()/createQboPurchaseOrder() calls reduce()
 * would have run -- same order as reduce() itself (acknowledge, THEN QBO).
 * Re-acknowledging matters because a lock can land in Review Required from
 * acknowledgeOrder() itself throwing in reduce() (e.g. a transient Walmart
 * 5xx), in which case NEITHER QBO call ever ran and the order is still
 * genuinely unacknowledged -- skipping straight to the QBO calls would mark
 * the lock Completed while leaving the order unacknowledged with Walmart. All
 * three calls are safe to repeat: acknowledge is documented safe to repeat
 * (and this file swallows the specific "already shipped, acknowledgment not
 * required" 400 rather than treating it as a failure -- see
 * acknowledgeOrder()'s comment), and the QBO calls are idempotent (DocNumber
 * query-before-create), so retrying a lock that actually half-succeeded (e.g.
 * Invoice created, PO creation threw) is safe -- the Invoice create just finds
 * itself and no-ops. On success the lock flips to Completed; on failure it
 * stays Review Required with the new error message, ready to retry again.
 *
 *
 * Script parameters:
 *   custscript_walqbo_sync_client_id_wm      - Walmart Marketplace API Client ID
 *   custscript_walqbo_sync_secret_wm         - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_walqbo_sync_env               - "PRODUCTION" or "SANDBOX", applies to BOTH Walmart and QBO calls
 *   custscript_walqbo_sync_client_id_qbo     - QBO app Client ID
 *   custscript_walqbo_sync_secret_qbo        - QBO app Client Secret (Password field type)
 *   custscript_walqbo_sync_qbo_company_id    - QBO company id / realmId
 *   custscript_walqbo_sync_qbo_incomeacct_id - QBO Account internal id for IncomeAccountRef on auto-created items
 *   custscript_walqbo_sync_qbo_expacct_id    - QBO Account internal id for ExpenseAccountRef on auto-created items
 *   custscript_walqbo_sync_qbo_ap_id         - QBO Account internal id for every Purchase Order's APAccountRef
 *
 */
define(
    ['N/ui/serverWidget', 'N/record', 'N/search', 'N/runtime', 'N/https', 'N/encode', 'N/cache', 'N/log', 'N/crypto/random', 'N/redirect'],
    (serverWidget, record, search, runtime, https, encode, cache, log, random, redirect) => {

        const SUBLIST_ID = 'custpage_locks';

        const BASE_URLS = {
            PRODUCTION: 'https://marketplace.walmartapis.com',
            SANDBOX: 'https://sandbox.walmartapis.com'
        };

        const PARAMS = {
            WALMART_CLIENT_ID: 'custscript_walqbo_sync_client_id_wm',
            WALMART_CLIENT_SECRET: 'custscript_walqbo_sync_secret_wm',
            ENVIRONMENT: 'custscript_walqbo_sync_env',
            QBO_CLIENT_ID: 'custscript_walqbo_sync_client_id_qbo',
            QBO_CLIENT_SECRET: 'custscript_walqbo_sync_secret_qbo',
            QBO_COMPANY_ID: 'custscript_walqbo_sync_qbo_company_id',
            QBO_INCOME_ACCOUNT_ID: 'custscript_walqbo_sync_qbo_incomeacct_id',
            QBO_EXPENSE_ACCOUNT_ID: 'custscript_walqbo_sync_qbo_expacct_id',
            QBO_AP_ACCOUNT_ID: 'custscript_walqbo_sync_qbo_ap_id'
        };

        const QBO_BASE_URLS = {
            PRODUCTION: 'https://quickbooks.api.intuit.com',
            SANDBOX: 'https://sandbox-quickbooks.api.intuit.com'
        };
        const QBO_TOKEN_ENDPOINT = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
        const QBO_MINOR_VERSION = '75';
        const QBO_CACHE_NAME = 'walQboCache';
        const QBO_CACHE_KEYS = { ACCESS_TOKEN: 'accessToken', REFRESH_TOKEN: 'refreshToken' };
        const QBO_TTL_SAFETY_MARGIN_SECONDS = 60;

        const TIREMATIC_QBO_CUSTOMER_NAME = 'TireMatic';
        const ELITE_WHEEL_WAREHOUSE_VENDOR_NAME = 'Elite Wheel Warehouse';

        const LOCK_RECORD = {
            TYPE: 'customrecord_wal_order_import_lock',
            FIELDS: {
                PO_ID: 'custrecord_wal_lock_po_id',
                STATUS: 'custrecord_wal_lock_status',
                SALES_ORDER: 'custrecord_wal_lock_sales_order',
                ERROR: 'custrecord_wal_lock_error'
            },
            STATUS: {
                PROCESSING: 'Processing',
                COMPLETED: 'Completed',
                REVIEW_REQUIRED: 'Review Required'
            }
        };

        function onRequest(context) {
            if (context.request.method === 'GET') {
                renderForm(context);
            } else {
                handleRetry(context);
            }
        }

        // ---------------------------------------------------------------
        // GET: list every Review Required lock as a checkbox-selectable row
        // ---------------------------------------------------------------

        function renderForm(context) {
            const form = serverWidget.createForm({ title: 'Walmart → QBO Sync Retry' });
            form.addSubmitButton({ label: 'Retry Selected' });

            const resultParam = context.request.parameters.custpage_result;
            if (resultParam) {
                form.addField({ id: 'custpage_banner', type: serverWidget.FieldType.INLINEHTML, label: ' ' })
                    .defaultValue = `<div style="padding:8px;margin-bottom:8px;background:#eef6ff;border:1px solid #b6d6f7;">${escapeHtml(resultParam)}</div>`;
            }

            const locks = findLocksByStatus(LOCK_RECORD.STATUS.REVIEW_REQUIRED);

            const sublist = form.addSublist({ id: SUBLIST_ID, type: serverWidget.SublistType.LIST, label: 'Locks Needing Review' });
            sublist.addField({ id: 'select', type: serverWidget.FieldType.CHECKBOX, label: 'Retry' });
            sublist.addField({ id: 'poid', type: serverWidget.FieldType.TEXT, label: 'Walmart PO ID' });
            sublist.addField({ id: 'salesorder', type: serverWidget.FieldType.TEXT, label: 'NetSuite Sales Order' });
            sublist.addField({ id: 'error', type: serverWidget.FieldType.TEXT, label: 'Last Error' });
            sublist.addField({ id: 'lockid', type: serverWidget.FieldType.TEXT, label: 'Lock Id' })
                .updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            sublist.addField({ id: 'salesorderid', type: serverWidget.FieldType.TEXT, label: 'Sales Order Id' })
                .updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });

            locks.forEach((lock, line) => {
                sublist.setSublistValue({ id: 'select', line, value: 'F' });
                sublist.setSublistValue({ id: 'poid', line, value: lock.purchaseOrderId || '(unknown)' });
                sublist.setSublistValue({ id: 'salesorder', line, value: lock.salesOrderText || '(none)' });
                sublist.setSublistValue({ id: 'error', line, value: (lock.error || '(no error message)').substring(0, 300) });
                sublist.setSublistValue({ id: 'lockid', line, value: String(lock.id) });
                // NetSuite's setSublistValue throws SSS_MISSING_REQD_ARGUMENT on an empty
                // string -- use a single space as the "no Sales Order" sentinel instead of
                // '', and treat a blank/whitespace value as absent when reading it back.
                sublist.setSublistValue({ id: 'salesorderid', line, value: lock.salesOrderId ? String(lock.salesOrderId) : ' ' });
            });

            if (!locks.length) {
                form.addField({ id: 'custpage_empty', type: serverWidget.FieldType.INLINEHTML, label: ' ' })
                    .defaultValue = '<p>No locks currently need review.</p>';
            }

            context.response.writePage(form);
        }

        function findLocksByStatus(status) {
            const lockSearch = search.create({
                type: LOCK_RECORD.TYPE,
                filters: [[LOCK_RECORD.FIELDS.STATUS, 'is', status]],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: LOCK_RECORD.FIELDS.PO_ID }),
                    search.createColumn({ name: LOCK_RECORD.FIELDS.SALES_ORDER }),
                    search.createColumn({ name: LOCK_RECORD.FIELDS.ERROR })
                ]
            });

            // Review Required should stay a short, actively-worked list -- if this
            // cap is ever hit, that's a signal something upstream needs attention,
            // not a reason to paginate.
            const results = lockSearch.run().getRange({ start: 0, end: 1000 }) || [];
            return results.map((r) => ({
                id: r.getValue({ name: 'internalid' }),
                purchaseOrderId: r.getValue({ name: LOCK_RECORD.FIELDS.PO_ID }),
                salesOrderId: r.getValue({ name: LOCK_RECORD.FIELDS.SALES_ORDER }),
                salesOrderText: r.getText({ name: LOCK_RECORD.FIELDS.SALES_ORDER }),
                error: r.getValue({ name: LOCK_RECORD.FIELDS.ERROR })
            }));
        }

        function escapeHtml(value) {
            return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }

        // ---------------------------------------------------------------
        // POST: re-fetch each selected order from Walmart, re-run QBO sync
        // ---------------------------------------------------------------

        function handleRetry(context) {
            const request = context.request;
            const lineCount = request.getLineCount({ group: SUBLIST_ID });

            const selected = [];
            for (let line = 0; line < lineCount; line++) {
                const isSelected = request.getSublistValue({ group: SUBLIST_ID, name: 'select', line }) === 'T';
                if (!isSelected) continue;
                selected.push({
                    lockId: request.getSublistValue({ group: SUBLIST_ID, name: 'lockid', line }),
                    purchaseOrderId: request.getSublistValue({ group: SUBLIST_ID, name: 'poid', line }),
                    salesOrderId: request.getSublistValue({ group: SUBLIST_ID, name: 'salesorderid', line })
                });
            }

            let succeeded = 0;
            let failed = 0;

            selected.forEach((entry) => {
                try {
                    retryOne(entry);
                    succeeded += 1;
                } catch (e) {
                    failed += 1;
                    log.error('QBO sync retry - failed', {
                        lockId: entry.lockId,
                        purchaseOrderId: entry.purchaseOrderId,
                        errorName: e && e.name,
                        errorMessage: e && e.message
                    });
                    setLockStatus(entry.lockId, LOCK_RECORD.STATUS.REVIEW_REQUIRED, e.message);
                }
            });

            redirect.toSuitelet({
                scriptId: runtime.getCurrentScript().id,
                deploymentId: runtime.getCurrentScript().deploymentId,
                parameters: { custpage_result: `Retried ${selected.length}: ${succeeded} succeeded, ${failed} failed.` }
            });
        }

        /** Re-fetches the order from Walmart and re-runs the same QBO create calls reduce() would have run. */
        function retryOne(entry) {
            if (!entry.salesOrderId || !entry.salesOrderId.trim()) {
                throw new Error(`Lock ${entry.lockId} has no NetSuite Sales Order recorded -- cannot retry QBO sync without it.`);
            }

            const salesOrderTranId = search.lookupFields({
                type: search.Type.SALES_ORDER, id: entry.salesOrderId, columns: ['tranid']
            }).tranid;

            const walmartCtx = getWalmartScriptParams();
            const baseUrl = BASE_URLS[walmartCtx.environment] || BASE_URLS.SANDBOX;
            const correlationId = random.generateUUID();
            const walmartAccessToken = getWalmartAccessToken({
                clientId: walmartCtx.clientId, clientSecret: walmartCtx.clientSecret, baseUrl, correlationId
            });
            const orderDetails = getOrderDetails({
                accessToken: walmartAccessToken, baseUrl, purchaseOrderId: entry.purchaseOrderId,
                correlationId, environment: walmartCtx.environment
            });

            // Re-acknowledge too -- a lock can land in Review
            // Required because acknowledgeOrder() itself threw in reduce() (e.g. a
            // transient Walmart 5xx), in which case NEITHER QBO call ever ran yet and the
            // order is still genuinely unacknowledged.
            acknowledgeOrder({
                accessToken: walmartAccessToken, baseUrl, purchaseOrderId: entry.purchaseOrderId,
                correlationId, environment: walmartCtx.environment
            });

            const ctx = getQboScriptParams();
            const accessToken = getQboAccessToken(ctx);

            const invoiceId = createQboInvoice({
                accessToken, ctx, salesOrderId: entry.salesOrderId, docNumber: salesOrderTranId, orderDetails
            });
            const qboPurchaseOrder = createQboPurchaseOrder({
                accessToken, ctx, salesOrderId: entry.salesOrderId, docNumber: salesOrderTranId, orderDetails
            });

            setLockStatus(entry.lockId, LOCK_RECORD.STATUS.COMPLETED, null);
            log.audit('QBO sync retry - completed', {
                purchaseOrderId: entry.purchaseOrderId, salesOrderId: entry.salesOrderId, qboInvoiceId: invoiceId,
                qboPurchaseOrderId: qboPurchaseOrder.qboPurchaseOrderId
            });
        }

        function setLockStatus(lockId, status, errorMessage) {
            try {
                const values = {};
                values[LOCK_RECORD.FIELDS.STATUS] = status;
                if (errorMessage) values[LOCK_RECORD.FIELDS.ERROR] = String(errorMessage).substring(0, 1000);

                record.submitFields({
                    type: LOCK_RECORD.TYPE, id: lockId, values,
                    options: { enableSourcing: false, ignoreMandatoryFields: true }
                });
            } catch (updateError) {
                log.error('QBO sync retry - failed to update lock status', { lockId, status, errorMessage: updateError.message });
            }
        }

        // ---------------------------------------------------------------
        // Walmart API (verbatim copy of wm_mr_order_import.js's helpers)
        // ---------------------------------------------------------------

        function safeJsonParse(body, correlationId, contextLabel) {
            try {
                return JSON.parse(body);
            } catch (e) {
                log.error({ title: `Failed to parse Walmart response as JSON (${contextLabel}, correlationId=${correlationId})`, details: body });
                throw new Error(`Walmart ${contextLabel} response was not valid JSON (correlationId=${correlationId}): ${body}`);
            }
        }

        function logHttpResponse(title, response, correlationId) {
            log[response.code >= 200 && response.code < 300 ? 'audit' : 'error']({
                title: `${title} (correlationId=${correlationId})`,
                details: JSON.stringify({ code: response.code, headers: response.headers, body: response.body })
            });
        }

        function getWalmartScriptParams() {
            const script = runtime.getCurrentScript();
            return {
                clientId: script.getParameter({ name: PARAMS.WALMART_CLIENT_ID }),
                clientSecret: script.getParameter({ name: PARAMS.WALMART_CLIENT_SECRET }),
                environment: (script.getParameter({ name: PARAMS.ENVIRONMENT }) || 'SANDBOX').toUpperCase()
            };
        }

        function getWalmartAccessToken(params) {
            const { clientId, clientSecret, baseUrl, correlationId } = params;
            const basicAuth = encode.convert({
                string: `${clientId}:${clientSecret}`, inputEncoding: encode.Encoding.UTF_8, outputEncoding: encode.Encoding.BASE_64
            });

            const response = https.post({
                url: `${baseUrl}/v3/token`,
                body: 'grant_type=client_credentials',
                headers: {
                    'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json', 'WM_QOS.CORRELATION_ID': correlationId, 'WM_SVC.NAME': 'Walmart Marketplace'
                }
            });

            logHttpResponse('Walmart token request', response, correlationId);
            if (response.code !== 200) throw new Error(`Walmart token request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);

            const parsed = safeJsonParse(response.body, correlationId, 'token');
            if (!parsed.access_token) throw new Error(`Walmart token response missing access_token (correlationId=${correlationId}): ${response.body}`);
            return parsed.access_token;
        }

        function getOrderDetails(params) {
            const { accessToken, baseUrl, purchaseOrderId, correlationId, environment } = params;
            const response = https.get({
                url: `${baseUrl}/v3/orders/${encodeURIComponent(purchaseOrderId)}`,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken, 'WM_SVC.NAME': 'Walmart Marketplace', 'WM_QOS.CORRELATION_ID': correlationId,
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}), 'Accept': 'application/json'
                }
            });

            logHttpResponse(`Walmart order details request (purchaseOrderId=${purchaseOrderId})`, response, correlationId);
            if (response.code !== 200) throw new Error(`Walmart order details request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);

            const parsed = safeJsonParse(response.body, correlationId, 'order details');
            if (!parsed.order) throw new Error(`Walmart order details response missing "order" wrapper (correlationId=${correlationId}): ${response.body}`);
            return parsed.order;
        }

        /**
         * POST /v3/orders/{purchaseOrderId}/acknowledge. Documented by
         * Walmart as safe to repeat on an order that's already Acknowledged.
         */
        function acknowledgeOrder(params) {
            const { accessToken, baseUrl, purchaseOrderId, correlationId, environment } = params;

            const response = https.post({
                url: `${baseUrl}/v3/orders/${encodeURIComponent(purchaseOrderId)}/acknowledge`,
                body: '',
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken, 'WM_SVC.NAME': 'Walmart Marketplace', 'WM_QOS.CORRELATION_ID': correlationId,
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}), 'Accept': 'application/json', 'Content-Type': 'application/json'
                }
            });

            logHttpResponse(`Walmart order acknowledge request (purchaseOrderId=${purchaseOrderId})`, response, correlationId);
            if (response.code !== 200) {
                if (response.code === 400 && /acknowledgment is not required/i.test(response.body)) {
                    log.audit(`Walmart order acknowledge skipped -- already acknowledged/shipped (purchaseOrderId=${purchaseOrderId}, correlationId=${correlationId})`, response.body);
                    return null;
                }
                throw new Error(`Walmart order acknowledge request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }
            return safeJsonParse(response.body, correlationId, 'order acknowledge');
        }

        // ---------------------------------------------------------------
        // QBO API (verbatim copy of wm_mr_order_import.js's helpers)
        // ---------------------------------------------------------------

        function getQboScriptParams() {
            const script = runtime.getCurrentScript();
            return {
                qboClientId: script.getParameter({ name: PARAMS.QBO_CLIENT_ID }),
                qboClientSecret: script.getParameter({ name: PARAMS.QBO_CLIENT_SECRET }),
                qboCompanyId: script.getParameter({ name: PARAMS.QBO_COMPANY_ID }),
                qboEnvironment: (script.getParameter({ name: PARAMS.ENVIRONMENT }) || 'SANDBOX').toUpperCase(),
                qboIncomeAccountId: script.getParameter({ name: PARAMS.QBO_INCOME_ACCOUNT_ID }),
                qboExpenseAccountId: script.getParameter({ name: PARAMS.QBO_EXPENSE_ACCOUNT_ID }),
                qboApAccountId: script.getParameter({ name: PARAMS.QBO_AP_ACCOUNT_ID })
            };
        }

        function getQboAccessToken(ctx) {
            const qboCache = cache.getCache({ name: QBO_CACHE_NAME, scope: cache.Scope.PROTECTED });

            const cachedAccessToken = qboCache.get({ key: QBO_CACHE_KEYS.ACCESS_TOKEN });
            if (cachedAccessToken) return cachedAccessToken;

            const refreshToken = qboCache.get({ key: QBO_CACHE_KEYS.REFRESH_TOKEN });
            if (!refreshToken) {
                throw new Error('No cached QBO refresh token -- someone needs to re-authorize via wm_sl_qbo_auth.js or a Postman OAuth flow.');
            }

            const basicAuth = encode.convert({
                string: `${ctx.qboClientId}:${ctx.qboClientSecret}`, inputEncoding: encode.Encoding.UTF_8, outputEncoding: encode.Encoding.BASE_64
            });

            const response = https.post({
                url: QBO_TOKEN_ENDPOINT,
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basicAuth}` },
                body: { grant_type: 'refresh_token', refresh_token: refreshToken }
            });

            if (response.code !== 200) throw new Error(`QBO token refresh failed (${response.code}): ${response.body}`);
            const parsed = JSON.parse(response.body);

            let accessTtl = parsed.expires_in;
            if (accessTtl > QBO_TTL_SAFETY_MARGIN_SECONDS) accessTtl -= QBO_TTL_SAFETY_MARGIN_SECONDS;
            qboCache.put({ key: QBO_CACHE_KEYS.ACCESS_TOKEN, value: parsed.access_token, ttl: accessTtl });

            if (parsed.refresh_token && parsed.x_refresh_token_expires_in) {
                qboCache.put({ key: QBO_CACHE_KEYS.REFRESH_TOKEN, value: parsed.refresh_token, ttl: parsed.x_refresh_token_expires_in });
            }

            log.audit('QBO sync retry - QBO access token refreshed', { environment: ctx.qboEnvironment });
            return parsed.access_token;
        }

        function qboBaseUrl(ctx) {
            return QBO_BASE_URLS[ctx.qboEnvironment] || QBO_BASE_URLS.SANDBOX;
        }

        function qboEscape(value) {
            return String(value).replace(/'/g, "''");
        }

        function qboQuery(params) {
            const { accessToken, ctx, query } = params;
            const response = https.post({
                url: `${qboBaseUrl(ctx)}/v3/company/${ctx.qboCompanyId}/query?minorversion=${QBO_MINOR_VERSION}`,
                headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/text' },
                body: query
            });
            if (response.code !== 200) throw new Error(`QBO query failed (${response.code}): ${response.body} -- query: ${query}`);
            return JSON.parse(response.body);
        }

        function qboCreate(params) {
            const { accessToken, ctx, path, body } = params;
            const response = https.post({
                url: `${qboBaseUrl(ctx)}/v3/company/${ctx.qboCompanyId}/${path}?minorversion=${QBO_MINOR_VERSION}`,
                headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (response.code < 200 || response.code >= 300) throw new Error(`QBO ${path} creation failed (${response.code}): ${response.body}`);
            return JSON.parse(response.body);
        }

        function findQboCustomerRef(params) {
            const { accessToken, ctx } = params;
            const query = `select Id, DisplayName from Customer where DisplayName = '${qboEscape(TIREMATIC_QBO_CUSTOMER_NAME)}'`;
            const result = qboQuery({ accessToken, ctx, query });
            const customers = (result.QueryResponse && result.QueryResponse.Customer) || [];

            if (!customers.length) throw new Error(`No QBO customer found with DisplayName "${TIREMATIC_QBO_CUSTOMER_NAME}" -- create it in QBO first.`);
            if (customers.length > 1) throw new Error(`Multiple QBO customers found with DisplayName "${TIREMATIC_QBO_CUSTOMER_NAME}" -- rename so it's unique.`);
            return { value: customers[0].Id, name: customers[0].DisplayName };
        }

        function findQboVendorRef(params) {
            const { accessToken, ctx, vendorName } = params;
            const query = `select Id, DisplayName from Vendor where DisplayName = '${qboEscape(vendorName)}'`;
            const result = qboQuery({ accessToken, ctx, query });
            const vendors = (result.QueryResponse && result.QueryResponse.Vendor) || [];

            if (!vendors.length) throw new Error(`No QBO vendor found with DisplayName "${vendorName}" -- create it in QBO first.`);
            if (vendors.length > 1) throw new Error(`Multiple QBO vendors found with DisplayName "${vendorName}" -- rename so it's unique.`);
            return { value: vendors[0].Id, name: vendors[0].DisplayName };
        }

        function findQboItemRefsBySku(params) {
            const { accessToken, ctx, skus } = params;
            const refsBySku = {};
            const BATCH_SIZE = 100;

            for (let i = 0; i < skus.length; i += BATCH_SIZE) {
                const batch = skus.slice(i, i + BATCH_SIZE);
                const quoted = batch.map((sku) => `'${qboEscape(sku)}'`).join(', ');
                const query = `select * from Item where Sku in (${quoted})`;
                const result = qboQuery({ accessToken, ctx, query });
                const items = (result.QueryResponse && result.QueryResponse.Item) || [];
                items.forEach((item) => { refsBySku[item.Sku] = { value: item.Id, name: item.Name }; });
            }
            return refsBySku;
        }

        function findItemPurchaseDescriptionBySku(sku) {
            const itemSearch = search.create({
                type: search.Type.ITEM, filters: [['itemid', 'is', sku]], columns: [search.createColumn({ name: 'purchasedescription' })]
            });
            const results = itemSearch.run().getRange({ start: 0, end: 1 }) || [];
            return results.length ? results[0].getValue({ name: 'purchasedescription' }) : null;
        }

        function createQboItem(params) {
            const { accessToken, ctx, sku, purchaseDescription } = params;
            if (!ctx.qboIncomeAccountId || !ctx.qboExpenseAccountId) {
                throw new Error(`QBO item for sku="${sku}" does not exist and cannot be auto-created -- `
                    + 'custscript_walqbo_sync_qbo_incomeacct_id / custscript_walqbo_sync_qbo_expacct_id are not set.');
            }

            const body = {
                Name: sku, Sku: sku, Active: true, FullyQualifiedName: sku, Taxable: false, Type: 'NonInventory',
                IncomeAccountRef: { value: ctx.qboIncomeAccountId }, ExpenseAccountRef: { value: ctx.qboExpenseAccountId },
                Description: purchaseDescription || sku, PurchaseDesc: purchaseDescription || sku, TrackQtyOnHand: false
            };

            const result = qboCreate({ accessToken, ctx, path: 'item', body });
            if (!result.Item) throw new Error(`QBO item creation for sku="${sku}" did not return an Item: ${JSON.stringify(result)}`);
            return { value: result.Item.Id, name: result.Item.Name };
        }

        function getOrCreateQboItemRefsBySku(params) {
            const { accessToken, ctx, skus } = params;
            const refsBySku = findQboItemRefsBySku({ accessToken, ctx, skus });

            for (const sku of skus) {
                if (refsBySku[sku]) continue;
                const purchaseDescription = findItemPurchaseDescriptionBySku(sku);
                refsBySku[sku] = createQboItem({ accessToken, ctx, sku, purchaseDescription });
                log.audit('QBO sync retry - QBO item auto-created', { sku, qboItemId: refsBySku[sku].value });
            }
            return refsBySku;
        }

        function findExistingQboInvoiceId(params) {
            const { accessToken, ctx, docNumber } = params;
            const query = `select Id from Invoice where DocNumber = '${qboEscape(docNumber)}'`;
            const result = qboQuery({ accessToken, ctx, query });
            const invoices = (result.QueryResponse && result.QueryResponse.Invoice) || [];
            return invoices.length ? invoices[0].Id : null;
        }

        function findExistingQboPurchaseOrderId(params) {
            const { accessToken, ctx, docNumber } = params;
            const query = `select Id from PurchaseOrder where DocNumber = '${qboEscape(docNumber)}'`;
            const result = qboQuery({ accessToken, ctx, query });
            const purchaseOrders = (result.QueryResponse && result.QueryResponse.PurchaseOrder) || [];
            return purchaseOrders.length ? purchaseOrders[0].Id : null;
        }

        function sumProductCharges(charges) {
            const chargeList = (charges && charges.charge) || [];
            let total = 0;
            for (const charge of chargeList) {
                if (charge.chargeType === 'PRODUCT' && charge.chargeAmount) total += Number(charge.chargeAmount.amount) || 0;
            }
            return total;
        }

        function roundTo(value, decimals) {
            const factor = Math.pow(10, decimals);
            return Math.round(value * factor) / factor;
        }

        /** Same US-variant normalization as wm_mr_order_import.js's normalizeCountryCode(). */
        function normalizeCountryCode(rawCountry) {
            const value = String(rawCountry || '').trim().toUpperCase();
            if (!value || value === 'USA' || value === 'US' || value === 'UNITED STATES' || value === 'UNITED STATES OF AMERICA') {
                return 'US';
            }
            return rawCountry;
        }

        /** Same QBO PhysicalAddress builder as wm_mr_order_import.js's buildQboShipAddr(). */
        function buildQboShipAddr(postalAddress) {
            if (!postalAddress || !postalAddress.address1) return null;

            return {
                Line1: postalAddress.name,
                Line2: postalAddress.address1,
                Line3: postalAddress.address2,
                City: postalAddress.city,
                CountrySubDivisionCode: postalAddress.state,
                PostalCode: postalAddress.postalCode,
                Country: normalizeCountryCode(postalAddress.country)
            };
        }

        function createQboInvoice(params) {
            const { accessToken, ctx, salesOrderId, docNumber, orderDetails } = params;
            const purchaseOrderId = orderDetails.purchaseOrderId;
            const orderLines = (orderDetails.orderLines && orderDetails.orderLines.orderLine) || [];

            const existingInvoiceId = findExistingQboInvoiceId({ accessToken, ctx, docNumber });
            if (existingInvoiceId) {
                log.audit('QBO sync retry - QBO invoice already exists, skipping create', { purchaseOrderId, docNumber, qboInvoiceId: existingInvoiceId });
                return existingInvoiceId;
            }

            const skus = orderLines.map((line) => line.item && line.item.sku).filter(Boolean);
            const customerRef = findQboCustomerRef({ accessToken, ctx });
            const itemRefsBySku = getOrCreateQboItemRefsBySku({ accessToken, ctx, skus });

            const lines = [];
            for (const line of orderLines) {
                const sku = line.item && line.item.sku;
                const quantity = Number(line.orderLineQuantity && line.orderLineQuantity.amount) || 0;
                if (!sku || quantity <= 0) continue;

                const rate = roundTo(sumProductCharges(line.charges), 2);
                const amount = roundTo(rate * quantity, 2);

                lines.push({
                    Amount: amount, DetailType: 'SalesItemLineDetail',
                    SalesItemLineDetail: { ItemRef: itemRefsBySku[sku], Qty: quantity, UnitPrice: rate, TaxCodeRef: { value: 'NON' } }
                });
            }

            if (!lines.length) throw new Error(`Walmart order ${purchaseOrderId} had no usable order lines for QBO invoice creation`);

            const postalAddress = (orderDetails.shippingInfo && orderDetails.shippingInfo.postalAddress) || {};
            const shipAddr = buildQboShipAddr(postalAddress);

            const body = {
                CustomerRef: customerRef, DocNumber: String(docNumber), Line: lines,
                PrivateNote: `Walmart purchaseOrderId: ${purchaseOrderId} / NetSuite Sales Order internal id: ${salesOrderId}`
            };
            if (shipAddr) body.ShipAddr = shipAddr;

            const result = qboCreate({ accessToken, ctx, path: 'invoice', body });
            if (!result.Invoice) throw new Error(`QBO invoice creation for purchaseOrderId=${purchaseOrderId}, docNumber=${docNumber} did not return an Invoice: ${JSON.stringify(result)}`);

            log.audit('QBO sync retry - QBO invoice created', { purchaseOrderId, docNumber, salesOrderId, qboInvoiceId: result.Invoice.Id });
            return result.Invoice.Id;
        }

        function createQboPurchaseOrder(params) {
            const { accessToken, ctx, salesOrderId, docNumber, orderDetails } = params;
            const purchaseOrderId = orderDetails.purchaseOrderId;
            const orderLines = (orderDetails.orderLines && orderDetails.orderLines.orderLine) || [];

            if (!ctx.qboApAccountId) throw new Error('custscript_walqbo_sync_qbo_ap_id is not set -- required as every QBO Purchase Order\'s APAccountRef.');

            const usableLines = orderLines.filter((line) => {
                const sku = line.item && line.item.sku;
                const quantity = Number(line.orderLineQuantity && line.orderLineQuantity.amount) || 0;
                return sku && quantity > 0;
            });
            if (!usableLines.length) throw new Error(`Walmart order ${purchaseOrderId} had no usable order lines for QBO purchase order creation`);

            const skus = usableLines.map((line) => line.item.sku);
            const itemRefsBySku = getOrCreateQboItemRefsBySku({ accessToken, ctx, skus });

            const existingPoId = findExistingQboPurchaseOrderId({ accessToken, ctx, docNumber });
            if (existingPoId) {
                log.audit('QBO sync retry - QBO purchase order already exists, skipping create', {
                    purchaseOrderId, docNumber, qboPurchaseOrderId: existingPoId
                });
                return { docNumber, qboPurchaseOrderId: existingPoId };
            }

            const vendorRef = findQboVendorRef({ accessToken, ctx, vendorName: ELITE_WHEEL_WAREHOUSE_VENDOR_NAME });

            const lines = usableLines.map((line) => {
                const sku = line.item.sku;
                const quantity = Number(line.orderLineQuantity.amount);
                const rate = roundTo(sumProductCharges(line.charges), 2);
                const amount = roundTo(rate * quantity, 2);

                return {
                    Amount: amount, DetailType: 'ItemBasedExpenseLineDetail',
                    ItemBasedExpenseLineDetail: { ItemRef: itemRefsBySku[sku], Qty: quantity, UnitPrice: rate, TaxCodeRef: { value: 'NON' } }
                };
            });

            const postalAddress = (orderDetails.shippingInfo && orderDetails.shippingInfo.postalAddress) || {};
            const shipAddr = buildQboShipAddr(postalAddress);

            const body = {
                VendorRef: vendorRef, APAccountRef: { value: ctx.qboApAccountId }, DocNumber: docNumber, Line: lines,
                PrivateNote: `Walmart purchaseOrderId: ${purchaseOrderId} / NetSuite Sales Order internal id: ${salesOrderId}`
            };
            if (shipAddr) body.ShipAddr = shipAddr;

            const result = qboCreate({ accessToken, ctx, path: 'purchaseorder', body });
            if (!result.PurchaseOrder) {
                throw new Error(`QBO purchase order creation for purchaseOrderId=${purchaseOrderId}, `
                    + `docNumber=${docNumber} did not return a PurchaseOrder: ${JSON.stringify(result)}`);
            }

            log.audit('QBO sync retry - QBO purchase order created', {
                purchaseOrderId, docNumber, salesOrderId, qboPurchaseOrderId: result.PurchaseOrder.Id
            });
            return { docNumber, qboPurchaseOrderId: result.PurchaseOrder.Id };
        }

        return { onRequest };
    }
);
