/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * On-demand lookup of an item's live Walmart listing. Enter up to 10 item
 * SKUs or internal IDs (one per line), and this calls Walmart directly
 * for EACH one and shows the raw response -- published status,
 * price, lifecycle status, and any unpublished/rejection reasons as Walmart
 * sees them right now. Useful for debugging "why doesn't this item look
 * right on Walmart" without waiting on/re-checking a feed submission.
 *
 * getItemDetails() calls a DIFFERENT endpoint per environment: 
 * SANDBOX uses GET /v1/simulations/items/{sku} (the dynamic sandbox lookup), while
 * PRODUCTION uses the regular GET /v3/items/{sku}.
 *
 *
 *
 * Script parameters:
 *   custscript_wal_details_client_id       - Walmart Marketplace API Client ID
 *   custscript_wal_details_client_secret   - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_details_env             - "PRODUCTION" or "SANDBOX" -- fixed per deployment,
 *                                            not user-selectable on the form
 *
 */
define(
    ['N/ui/serverWidget', 'N/runtime', 'N/https', 'N/encode', 'N/search', 'N/log', 'N/crypto/random'],
    (serverWidget, runtime, https, encode, search, log, random) => {

        const BASE_URLS = {
            PRODUCTION: 'https://marketplace.walmartapis.com',
            SANDBOX: 'https://sandbox.walmartapis.com'
        };

        const MAX_ITEMS = 10;

        /**
         * JSON.parse that logs the raw body before throwing, so a non-JSON
         * response (HTML error page, empty body, etc.) shows up in the
         * execution log instead of just an opaque "Unexpected token" message.
         */
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

        /** Logs code/headers/body for every Walmart call so nothing is left only on-screen or silently dropped. */
        function logHttpResponse(title, response, correlationId) {
            log[response.code === 200 ? 'audit' : 'error']({
                title: `${title} (correlationId=${correlationId})`,
                details: JSON.stringify({ code: response.code, headers: response.headers, body: response.body })
            });
        }

        /** Same OAuth client-credentials flow as the other Walmart scripts in this project. */
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

        /**
         * Fetches an item's live listing details from Walmart. SANDBOX uses
         * GET /v1/simulations/items/{sku} rather than GET /v3/items/{sku}
         * -- see file header for why.
         */
        function getItemDetails(params) {
            const { accessToken, baseUrl, sku, environment, correlationId } = params;
            const isSandbox = environment !== 'PRODUCTION';

            const url = isSandbox
                ? `${baseUrl}/v1/simulations/items/${encodeURIComponent(sku)}`
                : `${baseUrl}/v3/items/${encodeURIComponent(sku)}`;
            log.audit({ title: `Walmart item details request (correlationId=${correlationId})`, details: url });

            const response = https.get({
                url,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_QOS.CORRELATION_ID': correlationId,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    ...(isSandbox ? { 'WM_SANDBOX': 'v2' } : {}),
                    'Accept': 'application/json'
                }
            });

            logHttpResponse(`Walmart item details response (sku=${sku})`, response, correlationId);
            if (response.code !== 200) {
                throw new Error(`Walmart item details lookup failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }
            return safeJsonParse(response.body, correlationId, 'item details');
        }

        function getScriptParams() {
            const script = runtime.getCurrentScript();
            return {
                clientId: script.getParameter({ name: 'custscript_wal_details_client_id' }),
                clientSecret: script.getParameter({ name: 'custscript_wal_details_client_secret' }),
                defaultEnvironment: script.getParameter({ name: 'custscript_wal_details_env' }) || 'SANDBOX'
            };
        }

        function getBaseUrl(environment) {
            return environment === 'PRODUCTION' ? BASE_URLS.PRODUCTION : BASE_URLS.SANDBOX;
        }

        /**
         * Looks up an item directly by SKU or internal ID.
         * @returns {{id: string, sku: string}|null}
         */
        function findItem(lookup) {
            const trimmed = lookup.trim();
            const isNumeric = /^\d+$/.test(trimmed);
            const results = search.create({
                type: search.Type.ITEM,
                filters: [search.createFilter({
                    name: isNumeric ? 'internalid' : 'itemid',
                    operator: isNumeric ? search.Operator.ANYOF : search.Operator.IS,
                    values: [trimmed]
                })],
                columns: ['itemid']
            }).run().getRange({ start: 0, end: 1 });

            if (!results.length) return null;
            return { id: results[0].id, sku: results[0].getValue('itemid') };
        }

        /**
         * @param {Object} params
         * @param {string} [params.lookups] - repopulates the form after a lookup
         * @param {string} [params.resultText] - result/error message from the last lookup
         */
        function buildForm(params) {
            const form = serverWidget.createForm({
                title: `Walmart Item Details Lookup (up to ${MAX_ITEMS}, ${getScriptParams().defaultEnvironment})`
            });

            const lookupField = form.addField({
                id: 'custpage_item_lookups',
                type: serverWidget.FieldType.LONGTEXT,
                label: `Item SKUs or Internal IDs (one per line, up to ${MAX_ITEMS})`
            });
            lookupField.isMandatory = true;
            if (params.lookups) lookupField.defaultValue = params.lookups;

            form.addSubmitButton({ label: 'Get Item Details' });

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

        /**
         * Looks up and fetches Walmart details for one SKU/internal ID.
         * Own try/catch (rather than one wrapping the whole batch) so a
         * single bad SKU shows up as its own error section instead of
         * aborting the rest of the batch.
         */
        function lookupOne(params) {
            const { lookup, accessToken, baseUrl, environment } = params;
            // Fresh correlation ID per item -- each is its own Walmart call.
            const correlationId = random.generateUUID();
            try {
                const item = findItem(lookup);
                if (!item) {
                    return `--- "${lookup}" ---\nNo item found matching "${lookup}".`;
                }

                const details = getItemDetails({ accessToken, baseUrl, sku: item.sku, environment, correlationId });
                return `--- sku=${item.sku} (item #${item.id}) ---\n`
                    + `correlationId: ${correlationId} (reference this if you need to ask Walmart support about this item)\n\n`
                    + JSON.stringify(details, null, 2);
            } catch (e) {
                log.error({ title: `Item details lookup failed (lookup=${lookup}, correlationId=${correlationId})`, details: e });
                return `--- "${lookup}" ---\nError: ${e.message}\ncorrelationId: ${correlationId}\n\nSee execution log for full request/response details.`;
            }
        }

        const onRequest = (context) => {
            if (context.request.method !== 'POST') {
                context.response.writePage(buildForm({}));
                return;
            }

            const rawLookups = context.request.parameters.custpage_item_lookups || '';
            const lookups = rawLookups.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

            if (!lookups.length) {
                context.response.writePage(buildForm({ resultText: 'Enter at least one item SKU or internal ID.' }));
                return;
            }
            if (lookups.length > MAX_ITEMS) {
                context.response.writePage(buildForm({
                    lookups: rawLookups,
                    resultText: `Entered ${lookups.length} items -- max is ${MAX_ITEMS}. Remove ${lookups.length - MAX_ITEMS} and resubmit.`
                }));
                return;
            }

            const { clientId, clientSecret, defaultEnvironment } = getScriptParams();
            if (!clientId || !clientSecret) {
                context.response.writePage(buildForm({
                    lookups: rawLookups,
                    resultText: 'Missing custscript_wal_details_client_id / custscript_wal_details_client_secret script parameters.'
                }));
                return;
            }

            const baseUrl = getBaseUrl(defaultEnvironment);

            let resultText;
            try {
                // One token, reused for every item's GET below -- no need
                // to re-auth per item.
                const accessToken = getAccessToken({ clientId, clientSecret, baseUrl, correlationId: random.generateUUID() });
                const sections = lookups.map((lookup) => lookupOne({ lookup, accessToken, baseUrl, environment: defaultEnvironment }));
                resultText = sections.join('\n\n');
            } catch (e) {
                resultText = `Error fetching Walmart access token: ${e.message}\n\nSee execution log for full request/response details.`;
                log.error({ title: 'Item details batch lookup failed to authenticate', details: e });
            }

            context.response.writePage(buildForm({ lookups: rawLookups, resultText }));
        };

        return { onRequest };
    }
);
