/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * Ad hoc test against Walmart's POST /v1/simulations/items, supporting one
 * or more SKUs/internal IDs at a time, as an alternative to
 * wm_sl_test_upload.js's /v3/feeds submission. Built
 * because /v3/feeds full item creation always seems to fail with an
 * uninformative feedStatus: ERROR / itemsReceived: 0 in sandbox (see
 * conversation history around wm_sl_feed_status.js) -- /v1/simulations/items
 * is a separate endpoint confirmed to honor the WM_SANDBOX header, giving
 * real, readable validation feedback instead.
 *
 * CONFIRMED REQUEST CONTRACT (from Walmart's docs for this endpoint -- NOT
 * the /v3/feeds MPItemFeedHeader/MPItem/Orderable/Visible envelope, a much
 * smaller separate schema):
 *   Body: { items: [ { sku, productName, productType, condition, price: { amount, currency } } ] }
 *     - sku, productName, productType, price.amount, price.currency: required
 *     - condition: enum, not documented as required
 *   Headers: WM_SANDBOX (required, to reach the dynamic sandbox),
 *     WM_SEC.ACCESS_TOKEN (required), WM_SVC.NAME (required). No query
 *     params (unlike /v3/feeds?feedType=MP_ITEM).
 * Confirms Walmart's claim that dynamic sandbox test item creation supports
 * only a subset of item schema attributes -- this subset (sku/productName/
 * productType/condition/price) is ALL this endpoint takes. None of
 * wm_mr_tire_upload.js's Visible.Tires attributes (tireSize, tireType,
 * warrantyURL, etc.) have anywhere to go here, so this can't validate full
 * tire item data -- only auth/plumbing and this minimal shape.
 *
 * SANDBOX ONLY -- no environment selector, same reasoning as
 * wm_sl_test_upload.js.
 *
 * Does NOT write to customrecord_wal_feed_submission -- a simulation isn't
 * a real feed and has no feedId to track.
 *
 * Script parameters (own script record -- NetSuite param IDs are unique
 * account-wide, so these can't reuse wm_sl_test_upload.js's
 * custscript_wal_test_* IDs, hence the wal_item_sim_ prefix):
 *   custscript_wal_item_sim_client_id        - Walmart Marketplace API Client ID (SANDBOX)
 *   custscript_wal_item_sim_client_secret    - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_item_sim_saved_search_id  - internal ID of the same tire item saved search
 *                                              wm_mr_tire_upload.js / wm_sl_test_upload.js use
 */
define(
    ['N/ui/serverWidget', 'N/runtime', 'N/https', 'N/encode', 'N/search', 'N/log', 'N/crypto/random'],
    (serverWidget, runtime, https, encode, search, log, random) => {

        const BASE_URL = 'https://sandbox.walmartapis.com';

        // Each lookup runs its own saved-search execution against SuiteScript
        // governance (Suitelet budget: 1,000 units, ~10-15 units/search) --
        // capped well under that so a large paste fails fast with a clear
        // message instead of hitting SSS_USAGE_LIMIT_EXCEEDED mid-loop.
        const MAX_ITEMS = 10;

        // Only what POST /v1/simulations/items actually accepts -- see file header.
        const COLUMNS = {
            SKU: 'itemid',
            PRODUCT_NAME: 'salesdescription',
            PRICE: 'pricing.unitprice'
        };

        const PLACEHOLDERS = {
            productName: 'TEST TIRE - PLACEHOLDER PRODUCT NAME',
            price: 9.99
        };

        /** Splits the multi-line item-lines textarea into a list of SKU/internal-ID lookups. */
        function parseItemLines(raw) {
            return raw.split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean);
        }

        function getColumnValue(values, key) {
            const raw = values[key];
            if (raw === null || raw === undefined) return '';
            if (Array.isArray(raw)) {
                return raw.length ? (raw[0].text || raw[0].value || '') : '';
            }
            if (typeof raw === 'object') {
                return raw.text || raw.value || '';
            }
            return raw;
        }

        /**
         * Builds the minimal { sku, productName, productType, condition, price }
         * shape /v1/simulations/items takes (see file header). productType
         * 'Tires' matches the category name used elsewhere in this project
         * (walmart-spec-output/Tires.json, Visible.Tires) -- assumed right
         * here too, not separately confirmed.
         */
        function buildSimulationItem(values, internalId) {
            const sku = getColumnValue(values, COLUMNS.SKU) || `TEST-SKU-${internalId}`;
            const productName = getColumnValue(values, COLUMNS.PRODUCT_NAME) || PLACEHOLDERS.productName;
            const price = parseFloat(getColumnValue(values, COLUMNS.PRICE)) || PLACEHOLDERS.price;

            return {
                sku,
                productName,
                productType: 'Tires',
                condition: 'New',
                price: { amount: price, currency: 'USD' }
            };
        }

        function getScriptParams() {
            const script = runtime.getCurrentScript();
            return {
                clientId: script.getParameter({ name: 'custscript_wal_item_sim_client_id' }),
                clientSecret: script.getParameter({ name: 'custscript_wal_item_sim_client_secret' }),
                savedSearchId: script.getParameter({ name: 'custscript_wal_item_sim_saved_search_id' })
            };
        }

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

        function getAccessToken(params) {
            const { clientId, clientSecret, correlationId } = params;
            const basicAuth = encode.convert({
                string: `${clientId}:${clientSecret}`,
                inputEncoding: encode.Encoding.UTF_8,
                outputEncoding: encode.Encoding.BASE_64
            });
            const response = https.post({
                url: `${BASE_URL}/v3/token`,
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
         * Calls POST /v1/simulations/items with the confirmed { items: [...] }
         * body (see file header). Does NOT throw on non-200, unlike this
         * project's other Walmart calls -- the point of this tool is to
         * surface whatever validation detail Walmart returns, success or
         * not, so the caller always gets { code, body } to display.
         */
        function simulateItem(params) {
            const { accessToken, itemJson, correlationId } = params;
            const response = https.post({
                url: `${BASE_URL}/v1/simulations/items`,
                body: itemJson,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_QOS.CORRELATION_ID': correlationId,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'WM_SANDBOX': 'v2',
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });
            logHttpResponse('Walmart item simulation response', response, correlationId);

            let parsedOrRawBody;
            try {
                parsedOrRawBody = JSON.parse(response.body);
            } catch (e) {
                parsedOrRawBody = response.body; // not valid JSON -- show it raw rather than throwing it away
            }
            return { code: response.code, body: parsedOrRawBody };
        }

        function findItem(lookup) {
            const { savedSearchId } = getScriptParams();
            if (!savedSearchId) {
                throw new Error('Missing required script parameter: custscript_wal_item_sim_saved_search_id');
            }
            const loadedSearch = search.load({ id: savedSearchId });
            const isNumeric = /^\d+$/.test(lookup.trim());
            loadedSearch.filters.push(search.createFilter({
                name: isNumeric ? 'internalid' : 'itemid',
                operator: isNumeric ? search.Operator.ANYOF : search.Operator.IS,
                values: [lookup.trim()]
            }));
            const results = loadedSearch.run().getRange({ start: 0, end: 1 });
            return results.length ? results[0] : null;
        }

        function buildForm(params) {
            const form = serverWidget.createForm({ title: 'Walmart Item Creation Simulation (SANDBOX only, /v1/simulations/items)' });

            const lookupField = form.addField({
                id: 'custpage_item_lines',
                type: serverWidget.FieldType.TEXTAREA,
                label: `Item SKU(s) or Internal ID(s) -- one per line (max ${MAX_ITEMS})`
            });
            lookupField.isMandatory = true;
            if (params.itemLinesText) lookupField.defaultValue = params.itemLinesText;

            form.addSubmitButton({ label: 'Run Simulation' });

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

            const itemLinesText = context.request.parameters.custpage_item_lines;
            if (!itemLinesText) {
                context.response.writePage(buildForm({ resultText: 'Enter at least one item SKU or internal ID.' }));
                return;
            }

            const lookups = parseItemLines(itemLinesText);
            if (!lookups.length) {
                context.response.writePage(buildForm({ itemLinesText, resultText: 'Enter at least one item SKU or internal ID.' }));
                return;
            }
            if (lookups.length > MAX_ITEMS) {
                context.response.writePage(buildForm({
                    itemLinesText,
                    resultText: `Enter at most ${MAX_ITEMS} items at a time (got ${lookups.length}).`
                }));
                return;
            }

            let resultText;
            const correlationId = random.generateUUID();
            try {
                const notFound = [];
                const items = [];
                const receivedColumnKeysByLookup = [];
                for (const lookup of lookups) {
                    const result = findItem(lookup);
                    if (!result) {
                        notFound.push(lookup);
                        continue;
                    }
                    const values = result.getAllValues();
                    const receivedColumnKeys = Object.keys(values).sort();
                    receivedColumnKeysByLookup.push(`${lookup}: ${receivedColumnKeys.join(', ')}`);
                    log.debug({ title: `Saved search columns received (${lookup})`, details: receivedColumnKeys.join(', ') });
                    items.push(buildSimulationItem(values, result.id));
                }

                if (notFound.length) {
                    resultText = `No item found matching in the configured saved search: ${notFound.join(', ')}`;
                    context.response.writePage(buildForm({ itemLinesText, resultText }));
                    return;
                }

                const itemJson = JSON.stringify({ items }, null, 2);

                const { clientId, clientSecret } = getScriptParams();
                if (!clientId || !clientSecret) {
                    resultText = 'Missing custscript_wal_item_sim_client_id / custscript_wal_item_sim_client_secret '
                        + `script parameters.\n\nSaved search columns received:\n${receivedColumnKeysByLookup.join('\n')}`
                        + `\n\nBuilt items (not submitted):\n${itemJson}`;
                    context.response.writePage(buildForm({ itemLinesText, resultText }));
                    return;
                }

                const accessToken = getAccessToken({ clientId, clientSecret, correlationId });
                const simulationResult = simulateItem({ accessToken, itemJson, correlationId });

                resultText = `Simulation response code: ${simulationResult.code}\n\n`
                    + `correlationId: ${correlationId} (reference this if you need to ask Walmart support about this request)\n\n`
                    + `Saved search columns received:\n${receivedColumnKeysByLookup.join('\n')}\n\n`
                    + `Simulation response body:\n${JSON.stringify(simulationResult.body, null, 2)}\n\n`
                    + `Submitted item JSON:\n${itemJson}`;
            } catch (e) {
                resultText = `Error: ${e.message}\n\ncorrelationId: ${correlationId}\n\nSee execution log for full request/response details.`;
                log.error({ title: `Item simulation test failed (itemLines=${itemLinesText}, correlationId=${correlationId})`, details: e });
            }

            context.response.writePage(buildForm({ itemLinesText, resultText }));
        };

        return { onRequest };
    }
);
