/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Imports Walmart orders into NetSuite as Sales Orders, 
 * into Quickbooks as Invoices and Purchase Orders.
 * 
 *
 * Two ways this runs:
 *   1. Single-order (webhook-triggered): wm_sl_order_webhook.js submits a
 *      task with custscript_wal_order_import_po_id set to one purchaseOrderId.
 *      getInputData() returns just that one id.
 *   2. Reconciliation (hourly, no script param): getInputData() calls
 *      GET /v3/orders/released and processes every released order. This is
 *      the catch-all for anything the webhook missed or that failed --
 *      deploy this as its own scheduled deployment (not part of the
 *      webhook's rotation pool) so it always has a free slot to run hourly.
 *
 * Duplicate prevention (same pattern as
 * netsuite-scripts/integrations/fedex/fedex-labels-mr.js): a lock record
 * (customrecord_wal_order_import_lock) is created with externalid =
 * 'wal-order-' + purchaseOrderId before any Sales Order is created.
 * NetSuite enforces externalid uniqueness, so if the webhook path and the
 * hourly path both reach reduce() for the same order around the same time,
 * only one record.create() succeeds -- the other's save() throws, which is
 * treated as "another execution already owns this order" and skipped.
 *
 * buildSalesOrderFromWalmartOrder() creates the Sales Order against the
 * Tirematic customer (internal id 97623), mapping order lines by
 * Walmart SKU == NetSuite itemid.
 *
 * Missing-SKU handling: if a Walmart order line's SKU has no matching NetSuite
 * item, map() throws MissingNetSuiteItemError instead of a plain Error. Unlike
 * every other map()-stage failure, this does NOT release the lock -- it sets
 * the lock to ITEM_MISSING status and map() retries it in place on the next
 * hourly run (see the existingLock handling near the top of map()), so the
 * order keeps getting picked back up automatically once the item exists. A
 * one-time email (MISSING_ITEM_ALERT_RECIPIENTS) fires the first time this
 * happens for an order, and again only if the specific missing SKU/message
 * changes -- compared against the lock's previously-stored error text, so the
 * same unresolved problem doesn't re-email every hour.
 *
 * Map/reduce split: map() does lock acquisition + the Walmart fetch +
 * NetSuite Sales Order creation. reduce() picks up from
 * there and does the QuickBooks Online sync plus Walmart order acknowledgment
 * (POST /v3/orders/{purchaseOrderId}/acknowledge, required by Walmart before
 * an order can be shipped). Acknowledgment intentionally lives here, not in
 * map(), so it only ever fires for an order that's already been confirmed
 * buildable as a real Sales Order with every line mapped to a real NetSuite
 * item -- an order stuck retrying under ITEM_MISSING is never acknowledged.
 * Acknowledging is documented by Walmart as safe to repeat and does not
 * commit to fulfillment (a separate cancel API exists for orders that turn
 * out not to be fulfillable after acknowledgment), so there's no harm in
 * doing it proactively here rather than waiting for physical shipment.
 *
 * This matters because once map() succeeds, the NetSuite Sales Order
 * already exists -- an irreversible action -- so reduce()'s catch block
 * ALWAYS sets the lock to Review Required on failure, never releases it
 * (releasing would let the hourly scan create a second, duplicate Sales
 * Order just because QBO sync or Walmart acknowledgment failed). There is a
 * script, customscript_wal_qbo_sync_retry, that lists locks set to "Review
 * Required" and allows you to retry the Quickbooks sync.

 * map()'s catch is the opposite: any failure there means the Sales Order
 * was never created, so it's always safe to release the lock for a retry.
 *
 * QBO auth: getQboAccessToken() reads the SAME N/cache namespace
 * ('walQboCache', Scope.PROTECTED) that customscript_wal_qbo_auth_cache_refresh
 * (wm_sl_qbo_auth.js) and customscript_wal_qbo_sync_retry both also read/write.
 * QBO refresh tokens are 100-day rolling, so as long as the hourly
 * reconciliation run keeps calling this, no human should ever need to
 * re-authorize -- unless the cache is cleared/expires with nothing having
 * run in over 100 days, in which case getQboAccessToken() throws a clear
 * error rather than trying to redirect a browser (it has none). 
 * If the tokens expire, refer to customscript_wal_qbo_auth_cache_refresh, which
 * will refresh the tokens and store them in the cache.
 * 
 * QBO Invoice creation (createQboInvoice()): bills the QBO customer named
 * exactly TIREMATIC_QBO_CUSTOMER_NAME -- must already exist in the target QBO company,
 * this never creates the customer. DocNumber is the NetSuite Sales Order's tranid
 * (same convention qb-online-send-po-sl.js uses), which also doubles as an idempotency
 * check (query-before-create) since reduce() could in theory be retried by NetSuite's
 * own M/R retry mechanism within a single execution.
 *
 * QBO Purchase Order creation (createQboPurchaseOrder()): every Walmart order
 * gets exactly one QBO Purchase Order, billed to the fixed vendor
 * ELITE_WHEEL_WAREHOUSE_VENDOR_NAME. DocNumber is the same Sales Order tranid 
 * used for the Invoice, and the same query-before-create idempotency check applies. 
 * The original Walmart purchaseOrderId is preserved in the PO's PrivateNote alongside 
 * the NetSuite Sales Order internal id, same as the Invoice.
 *
 * Script parameters:
 *   custscript_wal_order_import_po_id      - single Walmart purchaseOrderId (webhook path only; omit for hourly scan)
 *   custscript_wal_order_import_client_id  - Walmart Marketplace API Client ID
 *   custscript_wal_order_import_secret     - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_order_import_env        - "PRODUCTION" or "SANDBOX"
 *   custscript_wal_order_import_fc_location_map - JSON string mapping Walmart order.shipNode.id
 *                                              -> NetSuite Location internal ID, e.g.
 *                                              {"10003175879":"1","20005551234":"34"} -- the
 *                                              inverse of wm_mr_inventory_feed_upload_multinode.js's
 *                                              ship node map. An order whose shipNode.id isn't a key
 *                                              here falls back to DEFAULT_LOCATION_ID (logged, not thrown,
 *                                              so an unmapped/new fulfillment center never blocks order import).
 *   custscript_wal_qbo_client_id            - QBO app Client ID (the dedicated Walmart-import app, NOT the existing Elite Wheel one)
 *   custscript_wal_qbo_client_secret        - QBO app Client Secret (Password field type)
 *   custscript_wal_qbo_company_id           - QBO company id / realmId
 *   custscript_wal_qbo_env                  - "PRODUCTION" or "SANDBOX" (defaults to SANDBOX)
 *   custscript_wal_qbo_income_acct_id       - QBO Account internal id used as IncomeAccountRef when
 *                                              createQboInvoice() has to auto-create a missing item
 *                                              (one fixed account for every Walmart/tire item -- no
 *                                              per-category split like Elite Wheel's Parts/Wheels map)
 *                                              TODO: currently set to the SANDBOX "Sales of Product
 *                                              Income" account id (79) for testing -- replace with the
 *                                              real production account id before going live.
 *   custscript_wal_qbo_expense_acct_id      - QBO Account internal id used as ExpenseAccountRef, same
 *                                              auto-create case as above
 *                                              TODO: currently set to the SANDBOX "Cost of Goods Sold"
 *                                              account id (80) for testing -- replace with the real
 *                                              production account id before going live.
 *   custscript_wal_qbo_ap_id                - QBO Account internal id used as every QBO Purchase
 *                                              Order's APAccountRef (one fixed AP account, same
 *                                              assumption qb-online-send-po-sl.js's apAccountRef makes)
 *                                              TODO: currently set to the SANDBOX Accounts Payable
 *                                              account id (33) for testing -- confirm/replace before
 *                                              going live.
 *
 * Lock record customrecord_wal_order_import_lock fields
 *   externalid                          - 'wal-order-' + purchaseOrderId (built-in field, enforces uniqueness)
 *   custrecord_wal_lock_po_id           - Free-Form Text, the Walmart purchaseOrderId
 *   custrecord_wal_lock_status          - List/Record or Free-Form Text: Processing | Completed | Review Required | Item Missing
 *                                          -- if this is a List/Record field, add "Item Missing" as a valid list value.
 *   custrecord_wal_lock_sales_order     - List/Record (Sales Order), set once created
 *   custrecord_wal_lock_error           - Free-Form Text (Long), last error message
 *
 * TODO: MISSING_ITEM_ALERT_AUTHOR (below) is a placeholder -- set it to a real
 * NetSuite employee internal id before this can send email.
 * TODO: update fulfillment center -> location map when production FCs are created.
 */
define(
    ['N/record', 'N/search', 'N/runtime', 'N/https', 'N/encode', 'N/cache', 'N/log', 'N/crypto/random', 'N/email'],
    (record, search, runtime, https, encode, cache, log, random, email) => {

        const BASE_URLS = {
            PRODUCTION: 'https://marketplace.walmartapis.com',
            SANDBOX: 'https://sandbox.walmartapis.com'
        };

        const PARAMS = {
            PO_ID: 'custscript_wal_order_import_po_id',
            CLIENT_ID: 'custscript_wal_order_import_client_id',
            CLIENT_SECRET: 'custscript_wal_order_import_secret',
            ENVIRONMENT: 'custscript_wal_order_import_env',
            QBO_CLIENT_ID: 'custscript_wal_qbo_client_id',
            QBO_CLIENT_SECRET: 'custscript_wal_qbo_client_secret',
            QBO_COMPANY_ID: 'custscript_wal_qbo_company_id',
            QBO_ENVIRONMENT: 'custscript_wal_qbo_env',
            QBO_INCOME_ACCOUNT_ID: 'custscript_wal_qbo_income_acct_id',
            QBO_EXPENSE_ACCOUNT_ID: 'custscript_wal_qbo_expense_acct_id',
            QBO_AP_ACCOUNT_ID: 'custscript_wal_qbo_ap_id',
            FC_LOCATION_MAP: 'custscript_wal_order_import_fc_loc_map'
        };

        const QBO_BASE_URLS = {
            PRODUCTION: 'https://quickbooks.api.intuit.com',
            SANDBOX: 'https://sandbox-quickbooks.api.intuit.com'
        };
        // Confirmed via Intuit's discovery documents -- same for both environments,
        // only the API base URL above differs between sandbox and production.
        const QBO_TOKEN_ENDPOINT = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
        const QBO_MINOR_VERSION = '75';
        // Same cache namespace wm_sl_qbo_auth.js writes to -- either that Suitelet
        // or a one-off Postman OAuth flow can be what populated it.
        const QBO_CACHE_NAME = 'walQboCache';
        const QBO_CACHE_KEYS = {
            ACCESS_TOKEN: 'accessToken',
            REFRESH_TOKEN: 'refreshToken'
        };
        const QBO_TTL_SAFETY_MARGIN_SECONDS = 60;

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
                REVIEW_REQUIRED: 'Review Required',
                // Set when map() can't find a NetSuite item for one of the order's SKUs.
                // Unlike every other map()-stage failure, this lock is NOT released --
                // map() instead reuses it and retries in place on the next hourly run
                // (see map()'s existingLock handling below), so the order keeps getting
                // re-attempted for as long as the item stays missing.
                ITEM_MISSING: 'Item Missing'
            }
        };

        // TODO: placeholder -- replace with the real NetSuite employee internal id to send
        // missing-item alert emails from (email.send() requires an author).
        const MISSING_ITEM_ALERT_AUTHOR = 126970; // 126971 for elite labels, 126970 = me
        // Same people as fedex-labels-mr.js's ITEM_DATA_ALERT_RECIPIENT, minus
        // labels@ewwfl.com.
        const MISSING_ITEM_ALERT_RECIPIENTS = [
            // 12493, // Nick
            // 82292, // Moka Kash
            // 28068, // Camilo Espinosa
            // 13     // Ricky Chavez
            126970 // Me
        ];

        /**
         * Thrown by buildSalesOrderFromWalmartOrder() when a Walmart order line's SKU has
         * no matching NetSuite item at all -- distinguished from every other map()-stage
         * error so the catch block in map() can route it to the ITEM_MISSING lock status
         * (retry-in-place + one-time email) instead of the normal release-and-retry path.
         */
        class MissingNetSuiteItemError extends Error {
            constructor(message, sku) {
                super(message);
                this.name = 'MissingNetSuiteItemError';
                this.sku = sku;
            }
        }

        /**
         * Sends the one-time "missing item" alert -- caller (map()) is responsible for only
         * calling this when the error message actually changed since the lock's last stored
         * error, so the same missing SKU doesn't re-email on every hourly retry. Failure to
         * send is logged, not thrown -- a missing/misconfigured recipient shouldn't also
         * block the lock status update that keeps the retry loop working.
         */
        function sendMissingItemAlertEmail(params) {
            const { purchaseOrderId, sku, message } = params;
            try {
                email.send({
                    author: MISSING_ITEM_ALERT_AUTHOR,
                    recipients: MISSING_ITEM_ALERT_RECIPIENTS,
                    subject: `Walmart Order Import - Missing NetSuite Item - PO ${purchaseOrderId}`,
                    body: '<html><body>'
                        + `<p>Walmart order <strong>${purchaseOrderId}</strong> could not be imported as a NetSuite `
                        + `Sales Order because SKU <strong>${sku}</strong> has no matching NetSuite item (itemid).</p>`
                        + `<p>${message}</p>`
                        + '<p>This order will keep retrying automatically on the hourly reconciliation run once the '
                        + 'item exists in NetSuite -- no action needed here beyond creating/fixing the item.</p>'
                        + '</body></html>'
                });
                log.audit('Missing item alert email sent', { purchaseOrderId, sku });
            } catch (emailError) {
                log.error('Failed to send missing item alert email', {
                    purchaseOrderId, sku, errorMessage: emailError && emailError.message
                });
            }
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

            const fcLocationMapRaw = script.getParameter({ name: PARAMS.FC_LOCATION_MAP });
            let fcLocationMap = {};
            try {
                fcLocationMap = fcLocationMapRaw ? JSON.parse(fcLocationMapRaw) : {};
            } catch (e) {
                throw new Error(`${PARAMS.FC_LOCATION_MAP} is not valid JSON: ${e.message}`);
            }

            return {
                poId: script.getParameter({ name: PARAMS.PO_ID }) || null,
                clientId: script.getParameter({ name: PARAMS.CLIENT_ID }),
                clientSecret: script.getParameter({ name: PARAMS.CLIENT_SECRET }),
                environment: (script.getParameter({ name: PARAMS.ENVIRONMENT }) || 'SANDBOX').toUpperCase(),
                qboClientId: script.getParameter({ name: PARAMS.QBO_CLIENT_ID }),
                qboClientSecret: script.getParameter({ name: PARAMS.QBO_CLIENT_SECRET }),
                qboCompanyId: script.getParameter({ name: PARAMS.QBO_COMPANY_ID }),
                qboEnvironment: (script.getParameter({ name: PARAMS.QBO_ENVIRONMENT }) || 'SANDBOX').toUpperCase(),
                qboIncomeAccountId: script.getParameter({ name: PARAMS.QBO_INCOME_ACCOUNT_ID }),
                qboExpenseAccountId: script.getParameter({ name: PARAMS.QBO_EXPENSE_ACCOUNT_ID }),
                qboApAccountId: script.getParameter({ name: PARAMS.QBO_AP_ACCOUNT_ID }),
                fcLocationMap
            };
        }

        /**
         * Reads the cached QBO access token (shared with wm_sl_qbo_auth.js),
         * refreshing from the cached refresh token if needed. Throws if
         * nothing usable is available; this can never redirect a browser to
         * re-authorize.
         */
        function getQboAccessToken(ctx) {
            const qboCache = cache.getCache({ name: QBO_CACHE_NAME, scope: cache.Scope.PROTECTED });

            const cachedAccessToken = qboCache.get({ key: QBO_CACHE_KEYS.ACCESS_TOKEN });
            if (cachedAccessToken) {
                log.debug('QBO access token cache hit', 'Returning cached access token without a refresh call.');
                return cachedAccessToken;
            }

            const refreshToken = qboCache.get({ key: QBO_CACHE_KEYS.REFRESH_TOKEN });
            log.audit('QBO access token cache miss, refreshing', {
                refreshTokenSource: refreshToken ? 'cache' : 'none available'
            });
            if (!refreshToken) {
                throw new Error('No cached QBO refresh token -- someone needs to re-authorize via wm_sl_qbo_auth.js.');
            }

            const basicAuth = encode.convert({
                string: `${ctx.qboClientId}:${ctx.qboClientSecret}`,
                inputEncoding: encode.Encoding.UTF_8,
                outputEncoding: encode.Encoding.BASE_64
            });

            const response = https.post({
                url: QBO_TOKEN_ENDPOINT,
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${basicAuth}`
                },
                body: { grant_type: 'refresh_token', refresh_token: refreshToken }
            });

            if (response.code !== 200) {
                throw new Error(`QBO token refresh failed (${response.code}): ${response.body}`);
            }

            const parsed = JSON.parse(response.body);

            let accessTtl = parsed.expires_in;
            if (accessTtl > QBO_TTL_SAFETY_MARGIN_SECONDS) accessTtl -= QBO_TTL_SAFETY_MARGIN_SECONDS;
            qboCache.put({ key: QBO_CACHE_KEYS.ACCESS_TOKEN, value: parsed.access_token, ttl: accessTtl });

            // QBO rotates the refresh token on every use -- the seed param is now
            // stale, the cache is the live source of truth from this point on.
            if (parsed.refresh_token && parsed.x_refresh_token_expires_in) {
                qboCache.put({ key: QBO_CACHE_KEYS.REFRESH_TOKEN, value: parsed.refresh_token, ttl: parsed.x_refresh_token_expires_in });
            }

            log.audit('QBO access token refreshed', { environment: ctx.qboEnvironment });
            return parsed.access_token;
        }

        /**
         * Webhook path: return just the one order id passed via script param.
         * Hourly path (no param): pull every currently-released order from
         * Walmart and let reduce()'s lock check skip anything already done.
         */
        function getInputData() {
            const ctx = getScriptParams();
            const correlationId = random.generateUUID();

            if (ctx.poId) {
                log.audit('Single order mode', { purchaseOrderId: ctx.poId });
                return [ctx.poId];
            }

            log.audit('Hourly reconciliation mode', 'No PO id param set; scanning all released orders.');

            const baseUrl = BASE_URLS[ctx.environment] || BASE_URLS.SANDBOX;
            const accessToken = getWalmartAccessToken({
                clientId: ctx.clientId,
                clientSecret: ctx.clientSecret,
                baseUrl,
                correlationId
            });

            const response = https.get({
                url: `${baseUrl}/v3/orders/released`,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'WM_QOS.CORRELATION_ID': correlationId,
                    ...(ctx.environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'Accept': 'application/json'
                }
            });

            logHttpResponse('Walmart released orders request', response, correlationId);
            if (response.code !== 200) {
                throw new Error(`Walmart released orders request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }

            const parsed = safeJsonParse(response.body, correlationId, 'released orders');
            const orders = (parsed.list && parsed.list.elements && parsed.list.elements.order) || [];
            const poIds = orders.map((o) => o.purchaseOrderId).filter(Boolean);

            log.audit('Released orders found', { count: poIds.length });
            return poIds;
        }

        /**
         * Lock acquisition + Walmart fetch + NetSuite Sales Order creation.
         * Only writes to reduce() on success -- a failure here means the Sales
         * Order was never created, so it's always safe to release the lock
         * (handled in the catch below) rather than leave it stuck.
         */
        function map(context) {
            const purchaseOrderId = JSON.parse(context.value);
            const lockKey = 'wal-order-' + purchaseOrderId;
            let lock = null;
            let existingLock = null;
            let isRetryOfExistingLock = false;

            try {
                existingLock = findLock(lockKey);
                if (existingLock) {
                    if (existingLock.status !== LOCK_RECORD.STATUS.ITEM_MISSING) {
                        log.audit('Skipped, lock already exists', {
                            purchaseOrderId,
                            lockId: existingLock.id,
                            lockStatus: existingLock.status
                        });
                        return;
                    }

                    // ITEM_MISSING is the one status map() retries instead of skipping --
                    // reuse the existing lock row rather than acquireLock()'ing a new one
                    // (its externalid already exists). Flip to Processing right away so a
                    // second concurrent execution touching this same order doesn't also
                    // see ITEM_MISSING and retry it at the same time.
                    log.audit('Retrying order previously blocked on a missing item', {
                        purchaseOrderId, lockId: existingLock.id
                    });
                    lock = { id: existingLock.id, key: lockKey };
                    isRetryOfExistingLock = true;
                    setLockStatus(lock, LOCK_RECORD.STATUS.PROCESSING);
                } else {
                    lock = acquireLock(lockKey, purchaseOrderId);
                    if (!lock) {
                        // acquireLock() already logged why (another execution won the race).
                        return;
                    }
                }

                const ctx = getScriptParams();
                const correlationId = random.generateUUID();
                const baseUrl = BASE_URLS[ctx.environment] || BASE_URLS.SANDBOX;
                const accessToken = getWalmartAccessToken({
                    clientId: ctx.clientId,
                    clientSecret: ctx.clientSecret,
                    baseUrl,
                    correlationId
                });

                const orderDetails = getOrderDetails({ accessToken, baseUrl, purchaseOrderId, correlationId, environment: ctx.environment });
                const salesOrderId = buildSalesOrderFromWalmartOrder(orderDetails, ctx.fcLocationMap);
                // save() only returns the internal id -- tranid is system-assigned at save time,
                // so it has to be read back separately rather than pulled off the in-memory record.
                const salesOrderTranId = search.lookupFields({ type: search.Type.SALES_ORDER, id: salesOrderId, columns: ['tranid'] }).tranid;

                log.audit('NetSuite Sales Order created, handing off to reduce for QBO sync', {
                    purchaseOrderId, salesOrderId, salesOrderTranId, lockId: lock.id
                });

                context.write(purchaseOrderId, {
                    lockId: lock.id, lockKey, salesOrderId, salesOrderTranId, orderDetails,
                    // Access token reused by reduce() for acknowledgeOrder()
                    accessToken, baseUrl
                });
            } catch (e) {
                log.error('Failed in map stage (no Sales Order created)', {
                    purchaseOrderId,
                    errorName: e && e.name,
                    errorMessage: e && e.message
                });

                if (lock && e instanceof MissingNetSuiteItemError) {
                    // Don't release -- update the lock in place and retry on the next hourly
                    // run instead of the normal delete-and-recreate cycle, so the "already
                    // notified" state below survives across attempts. Both sides truncated
                    // the same way setLockStatus() stores the error, so a message over 1000
                    // chars still compares equal instead of falsely looking "new" every time.
                    const previousError = existingLock && existingLock.status === LOCK_RECORD.STATUS.ITEM_MISSING
                        ? existingLock.error : null;
                    if (previousError !== truncateError(e.message)) {
                        sendMissingItemAlertEmail({ purchaseOrderId, sku: e.sku, message: e.message });
                    } else {
                        log.audit('Same missing item as last attempt, skipping duplicate email', {
                            purchaseOrderId, sku: e.sku
                        });
                    }
                    setLockStatus(lock, LOCK_RECORD.STATUS.ITEM_MISSING, e.message);
                    return;
                }

                // A retry of an existing ITEM_MISSING lock that failed for an UNRELATED
                // reason (not MissingNetSuiteItemError, e.g. a transient Walmart 5xx) --
                // leave that lock untouched rather than releasing/deleting it, or its
                // stored error (the dedup check above) is lost and the next real missing-
                // item retry re-sends the alert email for the same still-unresolved SKU.
                if (isRetryOfExistingLock) return;

                // Nothing irreversible happened -- always safe to release for retry.
                if (lock) releaseLock(lock);
            }
        }

        /**
         * QuickBooks Online sync (Invoice + Purchase Order), picking up from
         * whatever map() wrote. The NetSuite Sales Order already exists by the
         * time this runs -- an irreversible action -- so any failure here sets
         * the lock to Review Required and NEVER releases it, or the hourly scan
         * could create a duplicate Sales Order just because QBO sync failed.
         */
        function reduce(context) {
            const purchaseOrderId = context.key;
            const mapResult = JSON.parse(context.values[0]);
            const lock = { id: mapResult.lockId, key: mapResult.lockKey };

            try {
                const ctx = getScriptParams();

                const correlationId = random.generateUUID();
                acknowledgeOrder({
                    accessToken: mapResult.accessToken, baseUrl: mapResult.baseUrl,
                    purchaseOrderId, correlationId, environment: ctx.environment
                });
                log.audit('Order acknowledged with Walmart', { purchaseOrderId, salesOrderId: mapResult.salesOrderId });

                const accessToken = getQboAccessToken(ctx);

                const invoiceId = createQboInvoice({
                    accessToken, ctx, salesOrderId: mapResult.salesOrderId, docNumber: mapResult.salesOrderTranId, orderDetails: mapResult.orderDetails
                });
                const qboPurchaseOrder = createQboPurchaseOrder({
                    accessToken, ctx, salesOrderId: mapResult.salesOrderId, docNumber: mapResult.salesOrderTranId, orderDetails: mapResult.orderDetails
                });

                setLockStatus(lock, LOCK_RECORD.STATUS.COMPLETED, null, mapResult.salesOrderId);
                log.audit('Completed (Walmart acknowledged + NetSuite SO + QBO Invoice + QBO PO)', {
                    purchaseOrderId, salesOrderId: mapResult.salesOrderId, qboInvoiceId: invoiceId,
                    qboPurchaseOrderId: qboPurchaseOrder.qboPurchaseOrderId
                });
            } catch (e) {
                log.error('Failed in reduce stage (Walmart acknowledgment or QBO sync). NetSuite Sales Order created, lock will NOT be released', {
                    purchaseOrderId,
                    salesOrderId: mapResult.salesOrderId,
                    errorName: e && e.name,
                    errorMessage: e && e.message
                });
                setLockStatus(lock, LOCK_RECORD.STATUS.REVIEW_REQUIRED, e.message, mapResult.salesOrderId);
            }
        }

        // QBO customer this NetSuite account bills for every Walmart order -- must already
        // exist in the target QBO company (this never creates it), same drop-ship
        // relationship as TIREMATIC_CUSTOMER_ID on the NetSuite side.
        const TIREMATIC_QBO_CUSTOMER_NAME = 'TireMatic';

        // Every Walmart order's QBO Purchase Order is billed to this single vendor --
        // must already exist in the target QBO company (findQboVendorRef() never creates one).
        const ELITE_WHEEL_WAREHOUSE_VENDOR_NAME = 'Elite Wheel Warehouse';

        function qboBaseUrl(ctx) {
            return QBO_BASE_URLS[ctx.qboEnvironment] || QBO_BASE_URLS.SANDBOX;
        }

        // QBO's query language is SQL-like and takes raw string literals -- this project's
        // inputs (SKUs, the fixed customer name, a numeric purchaseOrderId) are all
        // internally controlled, but escape quotes anyway rather than trust that forever.
        function qboEscape(value) {
            return String(value).replace(/'/g, "''");
        }

        function qboQuery(params) {
            const { accessToken, ctx, query } = params;
            const response = https.post({
                url: `${qboBaseUrl(ctx)}/v3/company/${ctx.qboCompanyId}/query?minorversion=${QBO_MINOR_VERSION}`,
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/text'
                },
                body: query
            });
            if (response.code !== 200) {
                throw new Error(`QBO query failed (${response.code}): ${response.body} -- query: ${query}`);
            }
            return JSON.parse(response.body);
        }

        function qboCreate(params) {
            const { accessToken, ctx, path, body } = params;
            const response = https.post({
                url: `${qboBaseUrl(ctx)}/v3/company/${ctx.qboCompanyId}/${path}?minorversion=${QBO_MINOR_VERSION}`,
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });
            if (response.code < 200 || response.code >= 300) {
                throw new Error(`QBO ${path} creation failed (${response.code}): ${response.body}`);
            }
            return JSON.parse(response.body);
        }

        /** Looks up TIREMATIC_QBO_CUSTOMER_NAME -- throws if it's missing or ambiguous rather than guessing or creating one. */
        function findQboCustomerRef(params) {
            const { accessToken, ctx } = params;
            const query = `select Id, DisplayName from Customer where DisplayName = '${qboEscape(TIREMATIC_QBO_CUSTOMER_NAME)}'`;
            const result = qboQuery({ accessToken, ctx, query });
            const customers = (result.QueryResponse && result.QueryResponse.Customer) || [];

            if (!customers.length) {
                throw new Error(`No QBO customer found with DisplayName "${TIREMATIC_QBO_CUSTOMER_NAME}" -- create it in QBO first.`);
            }
            if (customers.length > 1) {
                throw new Error(`Multiple QBO customers found with DisplayName "${TIREMATIC_QBO_CUSTOMER_NAME}" -- rename so it's unique.`);
            }
            return { value: customers[0].Id, name: customers[0].DisplayName };
        }

        /** Same exact-DisplayName-match pattern as findQboCustomerRef(), against Vendor instead of Customer -- never creates one. */
        function findQboVendorRef(params) {
            const { accessToken, ctx, vendorName } = params;
            const query = `select Id, DisplayName from Vendor where DisplayName = '${qboEscape(vendorName)}'`;
            const result = qboQuery({ accessToken, ctx, query });
            const vendors = (result.QueryResponse && result.QueryResponse.Vendor) || [];

            if (!vendors.length) {
                throw new Error(`No QBO vendor found with DisplayName "${vendorName}" -- create it in QBO first.`);
            }
            if (vendors.length > 1) {
                throw new Error(`Multiple QBO vendors found with DisplayName "${vendorName}" -- rename so it's unique.`);
            }
            return { value: vendors[0].Id, name: vendors[0].DisplayName };
        }

        /**
         * select * rather than naming columns -- confirmed via direct query that this QBO
         * company never returns Sku in the response when it's named in an explicit column
         * list (even though WHERE Sku = ... matches correctly and the field really is
         * set). Naming columns silently made item.Sku undefined, so every result got
         * filed under the literal key "undefined" and every lookup missed, falling
         * through to createQboItem() and colliding with the item that was there all along.
         * QBO caps IN-clause results, so this batches defensively even though a single
         * order rarely has 100+ lines.
         */
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

        /** Same NetSuite item lookup as findItemInternalIdBySku(), pulling purchasedescription instead -- only needed when auto-creating a QBO item. */
        function findItemPurchaseDescriptionBySku(sku) {
            const itemSearch = search.create({
                type: search.Type.ITEM,
                filters: [['itemid', 'is', sku]],
                columns: [search.createColumn({ name: 'purchasedescription' })]
            });
            const results = itemSearch.run().getRange({ start: 0, end: 1 }) || [];
            return results.length ? results[0].getValue({ name: 'purchasedescription' }) : null;
        }

        /**
         * // TODO: items are created in QBO as NonInventory for testing to avoid
         * // needing fields AssetAccountRef, QtyOnHand, and InvStartDate
         * 
         * Creates a missing QBO item as NonInventory, using the one fixed
         * income/expense account pair from custscript_wal_qbo_income_acct_id /
         * custscript_wal_qbo_expense_acct_id -- no per-category account split
         * since every Walmart-import item is a tire (unlike Elite Wheel's
         * Parts/Wheels-keyed map in qb-online-send-po-sl.js).
         *
         * Name/FullyQualifiedName use the sku (short, already unique -- QBO's
         * Name field caps at 100 chars and must be unique per company), while
         * Description/PurchaseDesc use the NetSuite purchasedescription text --
         * same split Elite Wheel's script makes between linePartnumber and
         * purchaseDescription.
         */
        function createQboItem(params) {
            const { accessToken, ctx, sku, purchaseDescription } = params;
            if (!ctx.qboIncomeAccountId || !ctx.qboExpenseAccountId) {
                throw new Error(`QBO item for sku="${sku}" does not exist and cannot be auto-created -- `
                    + 'custscript_wal_qbo_income_acct_id / custscript_wal_qbo_expense_acct_id are not set.');
            }

            const body = {
                Name: sku,
                Sku: sku,
                Active: true,
                FullyQualifiedName: sku,
                Taxable: false,
                Type: 'NonInventory',
                IncomeAccountRef: { value: ctx.qboIncomeAccountId },
                ExpenseAccountRef: { value: ctx.qboExpenseAccountId },
                Description: purchaseDescription || sku,
                PurchaseDesc: purchaseDescription || sku,
                TrackQtyOnHand: false
            };

            const result = qboCreate({ accessToken, ctx, path: 'item', body });
            if (!result.Item) {
                throw new Error(`QBO item creation for sku="${sku}" did not return an Item: ${JSON.stringify(result)}`);
            }
            return { value: result.Item.Id, name: result.Item.Name };
        }

        /** Looks up every SKU on the order in one batch, auto-creating whichever ones QBO doesn't already have. */
        function getOrCreateQboItemRefsBySku(params) {
            const { accessToken, ctx, skus } = params;
            const refsBySku = findQboItemRefsBySku({ accessToken, ctx, skus });

            for (const sku of skus) {
                if (refsBySku[sku]) continue;

                const purchaseDescription = findItemPurchaseDescriptionBySku(sku);
                refsBySku[sku] = createQboItem({ accessToken, ctx, sku, purchaseDescription });
                log.audit('QBO item auto-created', { sku, qboItemId: refsBySku[sku].value });
            }
            return refsBySku;
        }

        /** DocNumber-based idempotency check -- reduce() could in theory be retried by NetSuite's own M/R retry within one execution. */
        function findExistingQboInvoiceId(params) {
            const { accessToken, ctx, docNumber } = params;
            const query = `select Id from Invoice where DocNumber = '${qboEscape(docNumber)}'`;
            const result = qboQuery({ accessToken, ctx, query });
            const invoices = (result.QueryResponse && result.QueryResponse.Invoice) || [];
            return invoices.length ? invoices[0].Id : null;
        }

        /** Same idempotency check as findExistingQboInvoiceId(), against PurchaseOrder instead of Invoice. */
        function findExistingQboPurchaseOrderId(params) {
            const { accessToken, ctx, docNumber } = params;
            const query = `select Id from PurchaseOrder where DocNumber = '${qboEscape(docNumber)}'`;
            const result = qboQuery({ accessToken, ctx, query });
            const purchaseOrders = (result.QueryResponse && result.QueryResponse.PurchaseOrder) || [];
            return purchaseOrders.length ? purchaseOrders[0].Id : null;
        }

        /**
         * Creates a QBO Invoice billing TIREMATIC_QBO_CUSTOMER_NAME for one Walmart
         * order, auto-creating any missing QBO item by SKU first. DocNumber is the
         * NetSuite Sales Order's tranid -- same convention qb-online-send-po-sl.js
         * uses (its invoiceNumber is also built off the NetSuite document's tranid,
         * not an external order id).
         *
         * Deliberately has NO shipping line -- Walmart's SHIPPING charge is handled
         * separately from this Invoice, same as buildSalesOrderFromWalmartOrder()'s
         * Sales Order. ShipAddr (see buildQboShipAddr()) IS set, though, from the
         * same Walmart postalAddress the Sales Order's shipaddress text field uses.
         *
         * TODO
         *   - Every line is marked TaxCodeRef "NON".
         *   - Every auto-created item uses the same fixed income/expense account
         *     pair regardless of item category (fine while this only ever sells
         *     tires; would need Elite Wheel's asset-account-keyed map if that changes).
         */
        function createQboInvoice(params) {
            const { accessToken, ctx, salesOrderId, docNumber, orderDetails } = params;
            const purchaseOrderId = orderDetails.purchaseOrderId;
            const orderLines = (orderDetails.orderLines && orderDetails.orderLines.orderLine) || [];

            const existingInvoiceId = findExistingQboInvoiceId({ accessToken, ctx, docNumber });
            if (existingInvoiceId) {
                log.audit('QBO invoice already exists, skipping create', { purchaseOrderId, docNumber, qboInvoiceId: existingInvoiceId });
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

                // Amount is derived FROM the rounded rate (computeLineRate()) rather than
                // computed separately, since QBO requires Amount === UnitPrice * Qty exactly
                // and rounding each side independently can drift apart by a cent.
                const rate = computeLineRate(line);
                const amount = roundTo(rate * quantity, 2);

                lines.push({
                    Amount: amount,
                    DetailType: 'SalesItemLineDetail',
                    SalesItemLineDetail: {
                        ItemRef: itemRefsBySku[sku],
                        Qty: quantity,
                        UnitPrice: rate,
                        TaxCodeRef: { value: 'NON' }
                    }
                });
            }

            if (!lines.length) {
                throw new Error(`Walmart order ${purchaseOrderId} had no usable order lines for QBO invoice creation`);
            }

            const postalAddress = (orderDetails.shippingInfo && orderDetails.shippingInfo.postalAddress) || {};
            const shipAddr = buildQboShipAddr(postalAddress);

            const body = {
                CustomerRef: customerRef,
                DocNumber: String(docNumber),
                Line: lines,
                PrivateNote: `Walmart purchaseOrderId: ${purchaseOrderId} / NetSuite Sales Order internal id: ${salesOrderId}`
            };
            if (shipAddr) body.ShipAddr = shipAddr;

            const result = qboCreate({ accessToken, ctx, path: 'invoice', body });
            if (!result.Invoice) {
                throw new Error(`QBO invoice creation for purchaseOrderId=${purchaseOrderId}, docNumber=${docNumber} did not return an Invoice: ${JSON.stringify(result)}`);
            }

            log.audit('QBO invoice created', { purchaseOrderId, docNumber, salesOrderId, qboInvoiceId: result.Invoice.Id });
            return result.Invoice.Id;
        }

        /**
         * Creates exactly one QBO Purchase Order per Walmart order, billed to the fixed
         * ELITE_WHEEL_WAREHOUSE_VENDOR_NAME vendor and custscript_wal_qbo_ap_id's Accounts
         * Payable account. DocNumber is the tranid as-is, same as the Invoice, with the
         * same query-before-create idempotency check.
         *
         * Deliberately has NO shipping line, unlike createQboInvoice()'s: Walmart's
         * SHIPPING charge is money collected from the end customer and paid back to
         * us for fulfilling the order, not a confirmed cost the drop-ship vendor
         * actually charged for freight -- adding it here would misstate what we owe
         * the vendor. Also no tax handling (every line TaxCodeRef "NON"), same fixed
         * income/expense account pair for any newly auto-created item. ShipAddr IS
         * set (see buildQboShipAddr()), telling the drop-ship vendor where to send
         * the goods -- same Walmart postalAddress the Invoice's ShipAddr uses.
         */
        function createQboPurchaseOrder(params) {
            const { accessToken, ctx, salesOrderId, docNumber, orderDetails } = params;
            const purchaseOrderId = orderDetails.purchaseOrderId;
            const orderLines = (orderDetails.orderLines && orderDetails.orderLines.orderLine) || [];

            // Idempotency check first, same as createQboInvoice() -- avoids the item
            // lookup/auto-create calls below on every retry of an order whose PO already exists.
            const existingPoId = findExistingQboPurchaseOrderId({ accessToken, ctx, docNumber });
            if (existingPoId) {
                log.audit('QBO purchase order already exists, skipping create', {
                    purchaseOrderId, docNumber, qboPurchaseOrderId: existingPoId
                });
                return { docNumber, qboPurchaseOrderId: existingPoId };
            }

            if (!ctx.qboApAccountId) {
                throw new Error('custscript_wal_qbo_ap_id is not set -- required as every QBO Purchase Order\'s APAccountRef.');
            }

            const usableLines = orderLines.filter((line) => {
                const sku = line.item && line.item.sku;
                const quantity = Number(line.orderLineQuantity && line.orderLineQuantity.amount) || 0;
                return sku && quantity > 0;
            });
            if (!usableLines.length) {
                throw new Error(`Walmart order ${purchaseOrderId} had no usable order lines for QBO purchase order creation`);
            }

            const skus = usableLines.map((line) => line.item.sku);
            const itemRefsBySku = getOrCreateQboItemRefsBySku({ accessToken, ctx, skus });

            const vendorRef = findQboVendorRef({ accessToken, ctx, vendorName: ELITE_WHEEL_WAREHOUSE_VENDOR_NAME });

            const lines = usableLines.map((line) => {
                const sku = line.item.sku;
                const quantity = Number(line.orderLineQuantity.amount);
                const rate = computeLineRate(line);
                const amount = roundTo(rate * quantity, 2);

                return {
                    Amount: amount,
                    DetailType: 'ItemBasedExpenseLineDetail',
                    ItemBasedExpenseLineDetail: {
                        ItemRef: itemRefsBySku[sku],
                        Qty: quantity,
                        UnitPrice: rate,
                        TaxCodeRef: { value: 'NON' }
                    }
                };
            });

            const postalAddress = (orderDetails.shippingInfo && orderDetails.shippingInfo.postalAddress) || {};
            const shipAddr = buildQboShipAddr(postalAddress);

            const body = {
                VendorRef: vendorRef,
                APAccountRef: { value: ctx.qboApAccountId },
                DocNumber: docNumber,
                Line: lines,
                PrivateNote: `Walmart purchaseOrderId: ${purchaseOrderId} / NetSuite Sales Order internal id: ${salesOrderId}`
            };
            if (shipAddr) body.ShipAddr = shipAddr;

            const result = qboCreate({ accessToken, ctx, path: 'purchaseorder', body });
            if (!result.PurchaseOrder) {
                throw new Error(`QBO purchase order creation for purchaseOrderId=${purchaseOrderId}, `
                    + `docNumber=${docNumber} did not return a PurchaseOrder: ${JSON.stringify(result)}`);
            }

            log.audit('QBO purchase order created', {
                purchaseOrderId, docNumber, salesOrderId, qboPurchaseOrderId: result.PurchaseOrder.Id
            });
            return { docNumber, qboPurchaseOrderId: result.PurchaseOrder.Id };
        }

        /**
         * POST /v3/orders/{purchaseOrderId}/acknowledge -- no request body. Confirmed
         * via developer.walmart.com/us-marketplace/reference/acknowledgeorders: this
         * acknowledges the whole order (every line), response echoes the order back
         * with each line's status set to "Acknowledged". Re-acknowledging an order
         * that's already Acknowledged is documented as safe, so no idempotency check
         * is needed here the way findExistingQboInvoiceId()/findExistingQboPurchaseOrderId()
         * need one for QBO -- every call to this function is a no-op-or-succeed on
         * Walmart's side.
         */
        function acknowledgeOrder(params) {
            const { accessToken, baseUrl, purchaseOrderId, correlationId, environment } = params;

            const response = https.post({
                url: `${baseUrl}/v3/orders/${encodeURIComponent(purchaseOrderId)}/acknowledge`,
                body: '',
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'WM_QOS.CORRELATION_ID': correlationId,
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            logHttpResponse(`Walmart order acknowledge request (purchaseOrderId=${purchaseOrderId})`, response, correlationId);
            if (response.code !== 200) {
                throw new Error(`Walmart order acknowledge request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }
            return safeJsonParse(response.body, correlationId, 'order acknowledge');
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

            // Real response is wrapped in an outer "order" object -- unwrap here so
            // nothing downstream needs to know about this API shape.
            const parsed = safeJsonParse(response.body, correlationId, 'order details');
            if (!parsed.order) {
                throw new Error(`Walmart order details response missing "order" wrapper (correlationId=${correlationId}): ${response.body}`);
            }
            return parsed.order;
        }

        // NetSuite internal id for the Tirematic customer -- every Walmart order is created against this entity.
        const TIREMATIC_CUSTOMER_ID = 97623;

        // Sales Order fields this NetSuite account requires that aren't part of Walmart's
        // order payload.
        const SO_STATUS_FIELD = 'custbody_sales_order_status';
        const SO_STATUS = '5'; // "HOLD - Waiting for additional items"
        const DELIVERY_TYPE_FIELD = 'custbody_delivery_type';
        const DELIVERY_TYPE = '12'; // "Customer's Account"
        const DEFAULT_LOCATION_ID = '1'; // Tampa -- fallback when shipNode.id isn't in FC_LOCATION_MAP

        /**
         * Creates a NetSuite Sales Order from a GET /v3/orders/{purchaseOrderId}
         * response (see developer.walmart.com/us-marketplace/reference/getanorder
         * for the full schema).
         *
         * Memo, Location, Delivery Type, and SO Status are mandatory on this account's
         * Sales Order form but have nothing to do with Walmart's order data. Delivery
         * Type/SO Status are fixed values (Customer's Account / HOLD - Waiting for
         * additional items); Location is looked up from order.shipNode.id via
         * fcLocationMap, falling back to DEFAULT_LOCATION_ID (logged) if unmapped.
         */
        function buildSalesOrderFromWalmartOrder(orderDetails, fcLocationMap) {
            const purchaseOrderId = orderDetails.purchaseOrderId;
            const orderLines = (orderDetails.orderLines && orderDetails.orderLines.orderLine) || [];
            if (!orderLines.length) {
                throw new Error(`Walmart order ${purchaseOrderId} has no order lines`);
            }

            const shipNodeId = orderDetails.shipNode && orderDetails.shipNode.id;
            const locationId = (shipNodeId && fcLocationMap[shipNodeId]) || DEFAULT_LOCATION_ID;
            if (shipNodeId && !fcLocationMap[shipNodeId]) {
                log.error('Unmapped shipNode -- falling back to DEFAULT_LOCATION_ID', { purchaseOrderId, shipNodeId });
            }

            const salesOrder = record.create({ type: record.Type.SALES_ORDER, isDynamic: true });
            salesOrder.setValue({ fieldId: 'entity', value: TIREMATIC_CUSTOMER_ID });   // Customer
            salesOrder.setValue({ fieldId: 'otherrefnum', value: String(purchaseOrderId) }); // PO#
            salesOrder.setValue({ fieldId: 'memo', value: `Walmart order ${purchaseOrderId}` });
            salesOrder.setValue({ fieldId: 'location', value: locationId });
            salesOrder.setValue({ fieldId: 'custbody_walmart_order', value: true });      // Checkbox identifying this as a Walmart order.
            salesOrder.setValue({ fieldId: DELIVERY_TYPE_FIELD, value: DELIVERY_TYPE });
            salesOrder.setValue({ fieldId: SO_STATUS_FIELD, value: SO_STATUS });

            const postalAddress = (orderDetails.shippingInfo && orderDetails.shippingInfo.postalAddress) || {};
            setShippingAddress(salesOrder, postalAddress); 

            let linesAdded = 0;
            for (const line of orderLines) {
                const sku = line.item && line.item.sku;
                const quantity = Number(line.orderLineQuantity && line.orderLineQuantity.amount) || 0;
                if (!sku || quantity <= 0) continue;

                const itemInternalId = findItemInternalIdBySku(sku);
                if (!itemInternalId) {
                    throw new MissingNetSuiteItemError(
                        `No NetSuite item found with itemid="${sku}" for Walmart order ${purchaseOrderId} line ${line.lineNumber}`,
                        sku
                    );
                }

                // NetSuite computes the line's total amount itself from rate * quantity --
                // unlike the QBO functions, this one only ever needs the per-unit rate.
                const rate = computeLineRate(line);

                salesOrder.selectNewLine({ sublistId: 'item' });
                salesOrder.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: itemInternalId });
                salesOrder.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: quantity });
                salesOrder.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate', value: rate });
                salesOrder.commitLine({ sublistId: 'item' });
                linesAdded += 1;
            }

            if (linesAdded === 0) {
                throw new Error(`Walmart order ${purchaseOrderId} had no usable order lines (missing sku/quantity on all lines)`);
            }

            return salesOrder.save({ enableSourcing: true, ignoreMandatoryFields: false });
        }

        /**
         * Sets the Sales Order's ship-to address as formatted text
         */
        function setShippingAddress(salesOrder, postalAddress) {
            if (!postalAddress || !postalAddress.address1) return;

            const addressLines = [
                postalAddress.name,
                postalAddress.address1,
                postalAddress.address2,
                [postalAddress.city, postalAddress.state, postalAddress.postalCode].filter(Boolean).join(' '),
                normalizeCountryCode(postalAddress.country)
            ].filter(Boolean);

            salesOrder.setValue({ fieldId: 'shipaddress', value: addressLines.join('\n') });
        }

        /**
         * NetSuite's country field requires the 2-letter ISO code ("US") as its
         * internal value -- confirmed by a real INVALID_FLD_VALUE error, since
         * Walmart's actual sandbox response sends "USA" (3 letters), not "US"
         * as originally assumed. Only US variants are normalized since that's
         * all Walmart orders are expected to be for now; anything else passes
         * through as-is rather than guessing at other countries' codes.
         */
        function normalizeCountryCode(rawCountry) {
            const value = String(rawCountry || '').trim().toUpperCase();
            if (!value || value === 'USA' || value === 'US' || value === 'UNITED STATES' || value === 'UNITED STATES OF AMERICA') {
                return 'US';
            }
            return rawCountry;
        }

        /**
         * Builds a QBO PhysicalAddress object for an Invoice/PurchaseOrder's ShipAddr
         * from Walmart's postalAddress -- same source data as setShippingAddress()'s
         * NetSuite shipaddress text block, just split into QBO's structured Line1/
         * City/CountrySubDivisionCode/PostalCode/Country fields instead of one
         * formatted block. Returns null when there's no address to ship to.
         */
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

        /** Walmart SKU == NetSuite itemid, per the existing lookup convention in wm_sl_item_details.js. */
        function findItemInternalIdBySku(sku) {
            const itemSearch = search.create({
                type: search.Type.ITEM,
                filters: [['itemid', 'is', sku]],
                columns: [search.createColumn({ name: 'internalid' })]
            });
            const results = itemSearch.run().getRange({ start: 0, end: 1 }) || [];
            return results.length ? results[0].getValue({ name: 'internalid' }) : null;
        }

        /**
         * Sums PRODUCT-type charges (ItemPrice etc.) for one order line -- excludes SHIPPING
         * charges. Returns the PER-UNIT price, not a line total.
         */
        function sumProductCharges(charges) {
            const chargeList = (charges && charges.charge) || [];
            let total = 0;
            for (const charge of chargeList) {
                if (charge.chargeType === 'PRODUCT' && charge.chargeAmount) {
                    total += Number(charge.chargeAmount.amount) || 0;
                }
            }
            return total;
        }

        function roundTo(value, decimals) {
            const factor = Math.pow(10, decimals);
            return Math.round(value * factor) / factor;
        }

        /** Rounded per-unit rate for one order line -- shared by buildSalesOrderFromWalmartOrder()/createQboInvoice()/createQboPurchaseOrder(). */
        function computeLineRate(line) {
            return roundTo(sumProductCharges(line.charges), 2);
        }

        function findLock(lockKey) {
            const lockSearch = search.create({
                type: LOCK_RECORD.TYPE,
                filters: [['externalidstring', 'is', lockKey]],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: LOCK_RECORD.FIELDS.STATUS }),
                    // Needed so map() can tell whether an ITEM_MISSING retry hit the exact
                    // same problem as last time (skip re-emailing) or a new one (email again).
                    search.createColumn({ name: LOCK_RECORD.FIELDS.ERROR })
                ]
            });
            const results = lockSearch.run().getRange({ start: 0, end: 1 }) || [];
            if (!results.length) return null;

            return {
                id: results[0].getValue({ name: 'internalid' }),
                status: results[0].getValue({ name: LOCK_RECORD.FIELDS.STATUS }),
                error: results[0].getValue({ name: LOCK_RECORD.FIELDS.ERROR })
            };
        }

        /**
         * Relies on NetSuite enforcing externalid uniqueness as the atomic
         * compare-and-set: if two reduce() executions race for the same
         * purchaseOrderId, only one create+save succeeds. The loser's save()
         * throws, which is treated as "the other execution owns this order."
         */
        function acquireLock(lockKey, purchaseOrderId) {
            try {
                const lockRecord = record.create({ type: LOCK_RECORD.TYPE, isDynamic: false });
                lockRecord.setValue({ fieldId: 'externalid', value: lockKey });
                lockRecord.setValue({ fieldId: LOCK_RECORD.FIELDS.PO_ID, value: String(purchaseOrderId) });
                lockRecord.setValue({ fieldId: LOCK_RECORD.FIELDS.STATUS, value: LOCK_RECORD.STATUS.PROCESSING });

                const lockId = lockRecord.save({ enableSourcing: false, ignoreMandatoryFields: true });
                log.audit('Lock acquired', { purchaseOrderId, lockId });
                return { id: lockId, key: lockKey };
            } catch (lockError) {
                const existingLock = findLock(lockKey);
                if (existingLock) {
                    log.audit('Skipped, another execution won the lock race', {
                        purchaseOrderId,
                        lockId: existingLock.id,
                        lockStatus: existingLock.status
                    });
                    return null;
                }
                throw lockError;
            }
        }

        /** Same 1000-char cutoff map()'s dedup check truncates e.message to before comparing against this stored value. */
        function truncateError(message) {
            return String(message).substring(0, 1000);
        }

        function setLockStatus(lock, status, errorMessage, salesOrderId) {
            if (!lock || !lock.id) return;

            try {
                const values = {};
                values[LOCK_RECORD.FIELDS.STATUS] = status;
                if (errorMessage) values[LOCK_RECORD.FIELDS.ERROR] = truncateError(errorMessage);
                if (salesOrderId) values[LOCK_RECORD.FIELDS.SALES_ORDER] = salesOrderId;

                record.submitFields({
                    type: LOCK_RECORD.TYPE,
                    id: lock.id,
                    values,
                    options: { enableSourcing: false, ignoreMandatoryFields: true }
                });
            } catch (updateError) {
                log.error('Failed to update lock status', {
                    lockId: lock.id,
                    status,
                    errorMessage: updateError.message
                });
            }
        }

        function releaseLock(lock) {
            try {
                record.delete({ type: LOCK_RECORD.TYPE, id: lock.id });
                log.audit('Lock released', { lockId: lock.id });
            } catch (deleteError) {
                log.error('Failed to release lock', {
                    lockId: lock && lock.id,
                    errorMessage: deleteError.message
                });
            }
        }

        return { getInputData, map, reduce };
    }
);
