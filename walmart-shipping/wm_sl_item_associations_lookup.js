/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * 
 * Lookup item associations (shipping templates and fulfillment centers) for the 
 * given SKUs.
 *
 * https://developer.walmart.com/us-marketplace/reference/getitemassociations
 *
 * 
 * Script parameters:
 *   custscript_wal_item_assoc_client_id      - Walmart Marketplace API Client ID
 *   custscript_wal_item_assoc_client_secret  - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_item_assoc_env            - "PRODUCTION" or "SANDBOX" -- fixed per deployment,
 *                                              not user-selectable on the form 
 * */

define(
    ['N/ui/serverWidget', 'N/runtime', 'N/https', 'N/encode', 'N/log', 'N/crypto/random'],
    (serverWidget, runtime, https, encode, log, random) => {
        const BASE_URLS = {
            PRODUCTION: 'https://marketplace.walmartapis.com',
            SANDBOX: 'https://sandbox.walmartapis.com'
        };

        const MAX_SKUS = 50;

        const PARAMS = {
            CLIENT_ID: 'custscript_wal_item_assoc_client_id',
            CLIENT_SECRET: 'custscript_wal_item_assoc_client_secret',
            ENVIRONMENT: 'custscript_wal_item_assoc_env'
        };

        function getScriptParams() {
            const script = runtime.getCurrentScript();
            return {
                clientId: script.getParameter({ name: PARAMS.CLIENT_ID }),
                clientSecret: script.getParameter({ name: PARAMS.CLIENT_SECRET }),
                defaultEnvironment: (script.getParameter({ name: PARAMS.ENVIRONMENT }) || 'SANDBOX').toUpperCase()
            };
        }

        function getBaseUrl(environment) {
            return BASE_URLS[environment] || 'https://sandbox.walmartapis.com';
        }
        
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

        function getItemAssociations(params) {
            const { accessToken, baseUrl, skus, correlationId, environment } = params;

            const response = https.post({
                url: `${baseUrl}/v3/items/associations`,
                body: JSON.stringify({ items: skus.map((sku) => ({ sku })) }),
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_QOS.CORRELATION_ID': correlationId,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            if (response.code !== 200) {
                throw new Error(`Walmart item associations lookup failed (${response.code}): ${response.body}`);
            }
            return JSON.parse(response.body);
        }

        /**
         * Flattens one item's associations array into readable lines --
         * "shippingTemplate.name (type) -> shipNodeName" per association, plus
         * any per-SKU errors Walmart returned alongside it.
         */
        function formatItemAssociations(item) {
            const associations = Array.isArray(item.associations) ? item.associations : [];
            const errors = Array.isArray(item.errors) ? item.errors : [];

            const lines = associations.map((a) => {
                const template = a.shippingTemplate || {};
                return `  - ${template.name || '(unnamed template)'} [${template.type || '?'}, id=${template.id || '?'}] `
                    + `-> shipNode ${a.shipNodeName || '?'} (${a.shipNode || '?'})`;
            });

            if (!associations.length) lines.push('  (no associations returned)');
            errors.forEach((e) => lines.push(`  ERROR: ${JSON.stringify(e)}`));

            return lines.join('\n');
        }

        /**
         * @param {Object} params
         * @param {string} [params.skus] - repopulates the form after a lookup
         * @param {string} [params.resultText] - result/error message from the last lookup
         */
        function buildForm(params) {
            const form = serverWidget.createForm({
                title: `Walmart Item Associations Lookup (up to ${MAX_SKUS} SKUs, ${getScriptParams().defaultEnvironment})`
            });

            const skuField = form.addField({
                id: 'custpage_skus',
                type: serverWidget.FieldType.LONGTEXT,
                label: `SKUs (one per line, up to ${MAX_SKUS})`
            });
            skuField.isMandatory = true;
            if (params.skus) {
                skuField.defaultValue = params.skus;
            }

            form.addSubmitButton({ label: 'Search' });

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

        function onRequest(context) {
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

            const { clientId, clientSecret, defaultEnvironment }= getScriptParams();
            if (!clientId || !clientSecret) {
                context.response.writePage(buildForm({
                    skus: rawSkus,
                    resultText: 'Missing Walmart client ID or client secret. Check script params.'
                }));
                return;
            }

            const baseUrl = getBaseUrl(defaultEnvironment);

            let resultText;
            let correlationId = random.generateUUID();
            
            try {
                const accessToken = getAccessToken({ clientId, clientSecret, baseUrl, correlationId });

                correlationId = random.generateUUID();
                const response = getItemAssociations({ accessToken, baseUrl, skus, correlationId, environment: defaultEnvironment });
                const items = Array.isArray(response.items) ? response.items : [];

                const foundSkus = new Set(items.map((item) => item.sku));
                const missingSkus = skus.filter((sku) => !foundSkus.has(sku));

                const detailBlocks = items.map((item) => `--- ${item.sku} ---\n${formatItemAssociations(item)}`);
                if (missingSkus.length) {
                    detailBlocks.push(`--- Not returned by Walmart at all ---\n  ${missingSkus.join(', ')}`);
                }

                resultText = `correlationId: ${correlationId} (reference this if you need to ask Walmart support about this request)\n\n`
                    + detailBlocks.join('\n\n');
            } catch (e) {
                resultText = `Error: ${e.message}\n\ncorrelationId: ${correlationId}\n\nSee execution log for full request/response details.`;
                log.error({ title: `Item associations lookup failed (correlationId=${correlationId})`, details: e });
            }

            context.response.writePage(buildForm({ skus: rawSkus, resultText }));
        };

        return { onRequest };
});