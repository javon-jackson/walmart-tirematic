/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * On-demand Walmart inventory lookup for up to MAX_SKUS SKUs. Enter one SKU
 * per line; fetches a single OAuth token (against whichever environment
 * THIS deployment's custscript_wal_invlkp_env parameter is set to), then calls GET
 * /v3/inventory?sku= once per SKU.
 *
 * One SKU's lookup failure doesn't abort the batch -- each is tried
 * independently and its error (if any) shown alongside successful results,
 * same as wm_sl_test_upload_multi.js's per-item not-found handling.
 *
 *
 * Script parameters:
 *   custscript_wal_invlkp_client_id       - Walmart Marketplace API Client ID
 *   custscript_wal_invlkp_client_secret   - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_invlkp_env             - "PRODUCTION" or "SANDBOX" -- fixed per deployment, not
 *                                           user-selectable on the form
 *
 */
define(
    ['N/ui/serverWidget', 'N/runtime', 'N/https', 'N/encode', 'N/log', 'N/crypto/random'],
    (serverWidget, runtime, https, encode, log, random) => {

        const BASE_URLS = {
            PRODUCTION: 'https://marketplace.walmartapis.com',
            SANDBOX: 'https://sandbox.walmartapis.com'
        };

        const MAX_SKUS = 10;

        function getAccessToken(params) {
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

            if (response.code !== 200) {
                throw new Error(`Walmart token request failed (${response.code}): ${response.body}`);
            }

            const parsed = JSON.parse(response.body);
            if (!parsed.access_token) {
                throw new Error(`Walmart token response missing access_token: ${response.body}`);
            }
            return parsed.access_token;
        }

        /** GET /v3/inventory?sku= -- current inventory for one SKU. */
        function getInventory(params) {
            const { accessToken, baseUrl, sku, correlationId } = params;

            const response = https.get({
                url: `${baseUrl}/v3/inventory?sku=${encodeURIComponent(sku)}`,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_QOS.CORRELATION_ID': correlationId,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'Accept': 'application/json'
                }
            });

            if (response.code !== 200) {
                throw new Error(`Walmart inventory lookup failed (${response.code}): ${response.body}`);
            }
            return JSON.parse(response.body);
        }

        /**
         * Pulls total quantity from a GET /v3/inventory response -- same
         * shape wm_sl_inventory_update.js's getCurrentQuantity() reads.
         * @returns {number|undefined}
         */
        function extractQuantity(details) {
            return (details && details.quantity && typeof details.quantity.amount === 'number')
                ? details.quantity.amount
                : undefined;
        }

        function getScriptParams() {
            const script = runtime.getCurrentScript();
            return {
                clientId: script.getParameter({ name: 'custscript_wal_invlkp_client_id' }),
                clientSecret: script.getParameter({ name: 'custscript_wal_invlkp_client_secret' }),
                defaultEnvironment: script.getParameter({ name: 'custscript_wal_invlkp_env' }) || 'SANDBOX'
            };
        }

        function getBaseUrl(environment) {
            return environment === 'PRODUCTION' ? BASE_URLS.PRODUCTION : BASE_URLS.SANDBOX;
        }

        /**
         * @param {Object} params
         * @param {string} [params.skus] - repopulates the form after a lookup
         * @param {string} [params.resultText] - result/error message from the last lookup
         */
        function buildForm(params) {
            const form = serverWidget.createForm({
                title: `Walmart Inventory Lookup (up to ${MAX_SKUS} SKUs, ${getScriptParams().defaultEnvironment})`
            });

            const skuField = form.addField({
                id: 'custpage_skus',
                type: serverWidget.FieldType.LONGTEXT,
                label: `SKUs (one per line, up to ${MAX_SKUS})`
            });
            skuField.isMandatory = true;
            if (params.skus) skuField.defaultValue = params.skus;

            form.addSubmitButton({ label: 'Look Up' });

            if (params.resultText) {
                const resultField = form.addField({
                    id: 'custpage_result',
                    type: serverWidget.FieldType.LONGTEXT,
                    label: 'Result'
                });
                resultField.defaultValue = params.resultText;
                resultField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
            }

            return form;
        }

        const onRequest = (context) => {
            if (context.request.method !== 'POST') {
                context.response.writePage(buildForm({}));
                return;
            }

            const rawSkus = context.request.parameters.custpage_skus || '';
            const skus = rawSkus.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

            if (!skus.length) {
                context.response.writePage(buildForm({ resultText: 'Enter at least one SKU.' }));
                return;
            }
            if (skus.length > MAX_SKUS) {
                context.response.writePage(buildForm({
                    skus: rawSkus,
                    resultText: `Entered ${skus.length} SKUs -- max is ${MAX_SKUS}. Remove ${skus.length - MAX_SKUS} and resubmit.`
                }));
                return;
            }

            const { clientId, clientSecret, defaultEnvironment } = getScriptParams();
            if (!clientId || !clientSecret) {
                context.response.writePage(buildForm({
                    skus: rawSkus,
                    resultText: 'Missing custscript_wal_invlkp_client_id / custscript_wal_invlkp_client_secret script parameters.'
                }));
                return;
            }

            const baseUrl = getBaseUrl(defaultEnvironment);

            let resultText;
            // Fetched once, reused across every SKU below (see file header).
            let correlationId = random.generateUUID();
            try {
                const accessToken = getAccessToken({ clientId, clientSecret, baseUrl, correlationId });

                // Own correlationId per SKU (own Walmart call); independent
                // try/catch so one failure doesn't stop the batch.
                const results = skus.map((sku) => {
                    const lookupCorrelationId = random.generateUUID();
                    try {
                        const details = getInventory({ accessToken, baseUrl, sku, correlationId: lookupCorrelationId });
                        return { sku, quantity: extractQuantity(details), correlationId: lookupCorrelationId, raw: details };
                    } catch (e) {
                        log.error({ title: `Inventory lookup failed (sku=${sku}, correlationId=${lookupCorrelationId})`, details: e });
                        return { sku, error: e.message, correlationId: lookupCorrelationId };
                    }
                });

                const summaryLines = results.map((r) => r.error
                    ? `  ${r.sku}: ERROR -- ${r.error} (correlationId=${r.correlationId})`
                    : `  ${r.sku}: ${r.quantity !== undefined ? r.quantity : '(quantity not found in response)'} (correlationId=${r.correlationId})`);

                const detailBlocks = results.map((r) => r.error
                    ? `--- ${r.sku} (ERROR) ---\n${r.error}`
                    : `--- ${r.sku} ---\n${JSON.stringify(r.raw, null, 2)}`);

                resultText = `Quantity summary:\n${summaryLines.join('\n')}\n\n`
                    + `Full responses:\n${detailBlocks.join('\n\n')}`;
            } catch (e) {
                resultText = `Error: ${e.message}\n\ncorrelationId: ${correlationId}\n\nSee execution log for full request/response details.`;
                log.error({ title: `Multi-SKU inventory lookup failed (correlationId=${correlationId})`, details: e });
            }

            context.response.writePage(buildForm({ skus: rawSkus, resultText }));
        };

        return { onRequest };
    }
);
