/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * Ad hoc test against Walmart's POST /v1/simulations/orders, which creates a
 * fake sandbox order for one or more existing item SKUs (with optional
 * per-line quantity). Useful for exercising order-side flows
 * (acknowledge/ship/etc.) without waiting on a real marketplace order.
 *
 * CONFIRMED REQUEST CONTRACT (developer.walmart.com/us-marketplace/reference/createanorder-1):
 *   Body: {
 *     customerEmailId,               // required
 *     shippingInfo: {                // required
 *       phone,
 *       postalAddress: { name, address1, city, state, postalCode, country, addressType }
 *     },
 *     orderLines: {                  // required, at least one orderLine
 *       orderLine: [
 *         { item: { sku }, orderLineQuantity: { unitOfMeasurement, amount } }
 *       ]
 *     }
 *   }
 *   Headers: WM_SANDBOX: v2 (required), WM_SEC.ACCESS_TOKEN (required),
 *     WM_SVC.NAME (required), Content-Type: application/json.
 *   Success response: 201 with { purchaseOrderId }. Note the success code is
 *     201, not 200 -- logHttpResponse below accounts for that.
 *
 * SANDBOX ONLY -- no environment selector, same reasoning as
 * wm_sl_test_upload.js.
 *
 * Does NOT write to customrecord_wal_feed_submission -- a simulation isn't
 * a real feed and has no feedId to track.
 *
 * Script parameters (own script record -- NetSuite param IDs are unique
 * account-wide, so these can't reuse wm_sl_test_upload.js's
 * custscript_wal_test_* IDs, hence the wal_order_sim_ prefix):
 *   custscript_wal_sim_order_client_id      - Walmart Marketplace API Client ID (SANDBOX)
 *   custscript_wal_sim_order_client_secret  - Walmart Marketplace API Client Secret (Password field type)
 *
 * Item lookup is a direct item search by SKU/internal ID (not the shared
 * saved search wm_mr_tire_upload.js / wm_sl_test_upload.js use) -- this
 * script only ever needs the SKU, so it doesn't need the gatekeeping of
 * "must appear in the Walmart-eligible saved search."
 */
define(
    ['N/ui/serverWidget', 'N/runtime', 'N/https', 'N/encode', 'N/search', 'N/log', 'N/crypto/random'],
    (serverWidget, runtime, https, encode, search, log, random) => {

        const BASE_URL = 'https://sandbox.walmartapis.com';

        // Each lookup runs its own item-search execution against SuiteScript
        // governance (Suitelet budget: 1,000 units, ~10-15 units/search) --
        // capped well under that so a large paste fails fast with a clear
        // message instead of hitting SSS_USAGE_LIMIT_EXCEEDED mid-loop.
        const MAX_ITEMS = 10;

        const COLUMNS = {
            SKU: 'itemid'
        };

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
         * Splits the multi-line item-lines textarea into { lookup, quantity } pairs.
         * Each line is "SKU or internal ID" or "SKU or internal ID, quantity" --
         * quantity defaults to "1" if omitted or not a positive integer.
         */
        function parseItemLines(raw) {
            return raw.split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean)
                .map(line => {
                    const [lookupPart, quantityPart] = line.split(',').map(part => (part || '').trim());
                    const quantity = /^\d+$/.test(quantityPart || '') ? quantityPart : '1';
                    return { lookup: lookupPart, quantity };
                });
        }

        function buildSimulationOrder(orderLineItems) {
            return {
                customerEmailId: "testuser123@gmail.com",
                shippingInfo: {
                    phone: "555-555-5555",
                    postalAddress: {
                        name: "Jane Doe",
                        address1: "3901 Riga Boulevard",
                        city: "Tampa",
                        state: "FL",
                        postalCode: "33619",
                        country: "USA",
                        addressType: "COMMERCIAL"
                    }
                },
                orderLines: {
                    orderLine: orderLineItems.map(({ sku, quantity }) => ({
                        item: {
                            sku
                        },
                        orderLineQuantity: {
                            unitOfMeasurement: "EACH",
                            amount: quantity
                        }
                    }))
                }
            };
        }

        function getScriptParams() {
            const script = runtime.getCurrentScript();
            return {
                clientId: script.getParameter({ name: 'custscript_wal_sim_order_client_id' }),
                clientSecret: script.getParameter({ name: 'custscript_wal_sim_order_client_secret' })
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
            log[response.code >= 200 && response.code < 300 ? 'audit' : 'error']({
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

        function simulateOrder(params) {
            const { accessToken, orderJson, correlationId } = params;
            const response = https.post({
                url: `${BASE_URL}/v1/simulations/orders`,
                body: orderJson,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_QOS.CORRELATION_ID': correlationId,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'WM_SANDBOX': 'v2',
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });
            logHttpResponse('Walmart order simulation response', response, correlationId);

            let parsedOrRawBody;
            try {
                parsedOrRawBody = JSON.parse(response.body);
            } catch (e) {
                parsedOrRawBody = response.body; // not valid JSON -- show it raw rather than throwing it away
            }
            return { code: response.code, body: parsedOrRawBody };
        }

        function findItem(lookup) {
            const isNumeric = /^\d+$/.test(lookup.trim());
            const itemSearch = search.create({
                type: search.Type.ITEM,
                filters: [
                    search.createFilter({
                        name: isNumeric ? 'internalid' : 'itemid',
                        operator: isNumeric ? search.Operator.ANYOF : search.Operator.IS,
                        values: [lookup.trim()]
                    })
                ],
                columns: [COLUMNS.SKU]
            });
            const results = itemSearch.run().getRange({ start: 0, end: 1 });
            return results.length ? results[0] : null;
        }

        function buildForm(params) {
            const form = serverWidget.createForm({ title: 'Walmart Order Simulation Test (SANDBOX only, /v1/simulations/orders)' });

            const lookupField = form.addField({
                id: 'custpage_item_lines',
                type: serverWidget.FieldType.TEXTAREA,
                label: `Item SKU(s) or Internal ID(s) -- one per line (max ${MAX_ITEMS}), optionally ", quantity" (default 1), e.g.\nSKU123\nSKU456, 3\n789012, 2`
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

            const itemLines = parseItemLines(itemLinesText);
            if (!itemLines.length) {
                context.response.writePage(buildForm({ itemLinesText, resultText: 'Enter at least one item SKU or internal ID.' }));
                return;
            }
            if (itemLines.length > MAX_ITEMS) {
                context.response.writePage(buildForm({
                    itemLinesText,
                    resultText: `Enter at most ${MAX_ITEMS} items at a time (got ${itemLines.length}).`
                }));
                return;
            }

            let resultText;
            const correlationId = random.generateUUID();
            try {
                const notFound = [];
                const orderLineItems = [];
                for (const { lookup, quantity } of itemLines) {
                    const result = findItem(lookup);
                    if (!result) {
                        notFound.push(lookup);
                        continue;
                    }
                    const values = result.getAllValues();
                    const sku = getColumnValue(values, COLUMNS.SKU) || `TEST-SKU-${result.id}`;
                    orderLineItems.push({ sku, quantity });
                }

                if (notFound.length) {
                    resultText = `No item found matching: ${notFound.join(', ')}`;
                    context.response.writePage(buildForm({ itemLinesText, resultText }));
                    return;
                }

                const order = buildSimulationOrder(orderLineItems);
                const orderJson = JSON.stringify(order, null, 2);

                const { clientId, clientSecret } = getScriptParams();
                if (!clientId || !clientSecret) {
                    resultText = 'Missing custscript_wal_order_sim_client_id / custscript_wal_order_sim_client_secret '
                        + `script parameters.\n\nBuilt order (not submitted):\n${orderJson}`;
                    context.response.writePage(buildForm({ itemLinesText, resultText }));
                    return;
                }

                const accessToken = getAccessToken({ clientId, clientSecret, correlationId });
                const simulationResult = simulateOrder({ accessToken, orderJson, correlationId });

                resultText = `Simulation response code: ${simulationResult.code}\n\n`
                    + `correlationId: ${correlationId} (reference this if you need to ask Walmart support about this request)\n\n`
                    + `Simulation response body:\n${JSON.stringify(simulationResult.body, null, 2)}\n\n`
                    + `Submitted order JSON:\n${orderJson}`;
            } catch (e) {
                resultText = `Error: ${e.message}\n\ncorrelationId: ${correlationId}\n\nSee execution log for full request/response details.`;
                log.error({ title: `Order simulation test failed (itemLines=${itemLinesText}, correlationId=${correlationId})`, details: e });
            }

            context.response.writePage(buildForm({ itemLinesText, resultText }));
        };

        return { onRequest };
    }
);
