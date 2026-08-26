/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * On-demand lookup of Walmart's Item Listing Quality insights -- quality
 * score, content/discoverability issues, offer/price competitiveness
 * issues, and performance stats (GMV, page views, conversion rate) for one
 * or more items, straight from Walmart's account-level insights data.
 *
 * Each value is its own independent POST, so one bad lookup is reported
 * inline without aborting the rest of the batch.
 *
 * Script parameters:
 *   custscript_wal_listing_quality_client_id      - Walmart Marketplace API Client ID
 *   custscript_wal_listing_quality_client_secret  - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_listing_quality_env            - "PRODUCTION" or "SANDBOX" (defaults to SANDBOX)
 */
define(
    ['N/ui/serverWidget', 'N/runtime', 'N/https', 'N/encode', 'N/log', 'N/crypto/random'],
    (serverWidget, runtime, https, encode, log, random) => {

        const BASE_URLS = {
            PRODUCTION: 'https://marketplace.walmartapis.com',
            SANDBOX: 'https://sandbox.walmartapis.com'
        };

        const MAX_ITEMS = 10;

        const LOOKUP_FIELDS = {
            SKU: 'sku',
            ITEM_ID: 'itemId',
            TITLE: 'title'
        };

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

        /** POST /v3/insights/items/listingQuality/items with a single {field, value} query. */
        function getListingQuality(params) {
            const { accessToken, baseUrl, field, value, environment, correlationId } = params;
            const isSandbox = environment !== 'PRODUCTION';

            const url = `${baseUrl}/v3/insights/items/listingQuality/items`;
            const body = JSON.stringify({ query: { field, value } });
            log.audit({ title: `Walmart listing quality request (correlationId=${correlationId})`, details: `${url} ${body}` });

            const response = https.post({
                url,
                body,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_QOS.CORRELATION_ID': correlationId,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    ...(isSandbox ? { 'WM_SANDBOX': 'v2' } : {}),
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            logHttpResponse(`Walmart listing quality response (${field}=${value})`, response, correlationId);
            if (response.code !== 200) {
                throw new Error(`Walmart listing quality lookup failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }
            return safeJsonParse(response.body, correlationId, 'listing quality');
        }

        function getScriptParams() {
            const script = runtime.getCurrentScript();
            return {
                clientId: script.getParameter({ name: 'custscript_wal_listing_qual_client_id' }),
                clientSecret: script.getParameter({ name: 'custscript_wal_listing_qual_secret' }),
                defaultEnvironment: script.getParameter({ name: 'custscript_wal_listing_qual_env' }) || 'SANDBOX'
            };
        }

        function getBaseUrl(environment) {
            return environment === 'PRODUCTION' ? BASE_URLS.PRODUCTION : BASE_URLS.SANDBOX;
        }

        /**
         * @param {Object} params
         * @param {string} [params.lookupField] - repopulates the dropdown after a lookup
         * @param {string} [params.lookups] - repopulates the form after a lookup
         * @param {string} [params.resultText] - result/error message from the last lookup
         */
        function buildForm(params) {
            const form = serverWidget.createForm({
                title: `Walmart Listing Quality Lookup (up to ${MAX_ITEMS}, ${getScriptParams().defaultEnvironment})`
            });

            const lookupFieldSelect = form.addField({
                id: 'custpage_lookup_field',
                type: serverWidget.FieldType.SELECT,
                label: 'Lookup By'
            });
            lookupFieldSelect.addSelectOption({ value: LOOKUP_FIELDS.SKU, text: 'SKU' });
            lookupFieldSelect.addSelectOption({ value: LOOKUP_FIELDS.ITEM_ID, text: 'Walmart Item ID' });
            lookupFieldSelect.addSelectOption({ value: LOOKUP_FIELDS.TITLE, text: 'Title' });
            lookupFieldSelect.defaultValue = params.lookupField || LOOKUP_FIELDS.SKU;

            const lookupsField = form.addField({
                id: 'custpage_lookups',
                type: serverWidget.FieldType.LONGTEXT,
                label: `Values (one per line, up to ${MAX_ITEMS})`
            });
            lookupsField.isMandatory = true;
            if (params.lookups) lookupsField.defaultValue = params.lookups;

            form.addSubmitButton({ label: 'Get Listing Quality' });

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
         * Looks up listing quality for one value. Own try/catch (rather than
         * one wrapping the whole batch) so a single bad lookup shows up as
         * its own error section instead of aborting the rest of the batch.
         */
        function lookupOne(params) {
            const { field, value, accessToken, baseUrl, environment } = params;
            // Fresh correlation ID per value -- each is its own Walmart call.
            const correlationId = random.generateUUID();
            try {
                const result = getListingQuality({ accessToken, baseUrl, field, value, environment, correlationId });
                const payload = result.payload || [];
                const summary = payload.length
                    ? payload.map((item) => `${item.sku || item.itemId}: qualityScore=${item.qualityScoreData && item.qualityScoreData.score}`).join('\n')
                    : 'No items matched.';

                return `--- ${field}=${value} ---\n`
                    + `correlationId: ${correlationId} (reference this if you need to ask Walmart support about this item)\n\n`
                    + `totalItems: ${result.totalItems}\n${summary}\n\n`
                    + JSON.stringify(result, null, 2);
            } catch (e) {
                log.error({ title: `Listing quality lookup failed (${field}=${value}, correlationId=${correlationId})`, details: e });
                return `--- ${field}=${value} ---\nError: ${e.message}\ncorrelationId: ${correlationId}\n\nSee execution log for full request/response details.`;
            }
        }

        const onRequest = (context) => {
            if (context.request.method !== 'POST') {
                context.response.writePage(buildForm({}));
                return;
            }

            const lookupField = context.request.parameters.custpage_lookup_field || LOOKUP_FIELDS.SKU;
            const rawLookups = context.request.parameters.custpage_lookups || '';
            const lookups = rawLookups.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

            if (!lookups.length) {
                context.response.writePage(buildForm({ lookupField, resultText: 'Enter at least one value to look up.' }));
                return;
            }
            if (lookups.length > MAX_ITEMS) {
                context.response.writePage(buildForm({
                    lookupField,
                    lookups: rawLookups,
                    resultText: `Entered ${lookups.length} values -- max is ${MAX_ITEMS}. Remove ${lookups.length - MAX_ITEMS} and resubmit.`
                }));
                return;
            }

            const { clientId, clientSecret, defaultEnvironment } = getScriptParams();
            if (!clientId || !clientSecret) {
                context.response.writePage(buildForm({
                    lookupField,
                    lookups: rawLookups,
                    resultText: 'Missing custscript_wal_listing_quality_client_id / custscript_wal_listing_quality_client_secret script parameters.'
                }));
                return;
            }

            const baseUrl = getBaseUrl(defaultEnvironment);

            let resultText;
            try {
                // One token, reused for every value's POST below -- no need
                // to re-auth per lookup.
                const accessToken = getAccessToken({ clientId, clientSecret, baseUrl, correlationId: random.generateUUID() });
                const sections = lookups.map((value) => lookupOne({ field: lookupField, value, accessToken, baseUrl, environment: defaultEnvironment }));
                resultText = sections.join('\n\n');
            } catch (e) {
                resultText = `Error fetching Walmart access token: ${e.message}\n\nSee execution log for full request/response details.`;
                log.error({ title: 'Listing quality batch lookup failed to authenticate', details: e });
            }

            context.response.writePage(buildForm({ lookupField, lookups: rawLookups, resultText }));
        };

        return { onRequest };
    }
);
