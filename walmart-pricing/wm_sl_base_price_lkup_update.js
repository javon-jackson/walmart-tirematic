/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * On-demand Walmart Marketplace BASE price lookup/update. Enter a SKU, pick
 * an Action ("Look Up Price" -- read-only -- or "Update Price," which
 * requires New Base Price), then click Submit.
 *
 * currentPriceType is hardcoded to "BASE".
 *
 * Both actions read price via getCurrentItemDetails(), split by
 * environment: SANDBOX uses GET /v1/simulations/items/{sku} (the dynamic
 * sandbox lookup, developer.walmart.com/us-marketplace/reference/getanitem-2,
 * requires the WM_SANDBOX header); PRODUCTION
 * uses the regular GET /v3/items/{sku}, since the simulations endpoint's
 * documented base URL is sandbox-only. extractPrice() matches whichever of
 * two confirmed shapes applies (production's array-wrapped
 * `ItemResponse[0].price.amount` vs. sandbox's flat `price.amount`); a third
 * shape is a defensive fallback only. Neither endpoint breaks price out by
 * type, so the value shown could reflect an active promo price rather than
 * the true BASE price.
 *
 * Every UPDATE attempt (success or failure) is written to the
 * customrecord_wal_base_price_updates tracking record  as an audit trail 
 * of who changed what SKU to what price, when, and with what result.
 *
 * Currency is hardcoded to USD.
 * 
 *
 * Custom record:
 *   Record type ID: customrecord_wal_base_price_updates
 *   Fields:
 *     custrecord_wal_priceupdate_sku          - Free-Form Text - the SKU that was updated
 *     custrecord_wal_priceupdate_new_price    - Currency - the price that was requested
 *     custrecord_wal_priceupdate_old_price    - Currency - price Walmart reported just before this
 *                                               update (best-effort via getCurrentItemDetails() --
 *                                               blank if that lookup failed or didn't match a known shape)
 *     custrecord_wal_priceupdate_type         - Free-Form Text - always "BASE" (kept for schema
 *                                               compatibility with when this field was dynamic --
 *                                               see the file header)
 *     custrecord_wal_priceupdate_status       - Free-Form Text - SUCCESS / ERROR
 *     custrecord_wal_priceupdate_response     - Long Text - raw Walmart response (or error message)
 *     custrecord_wal_priceupdate_env          - Free-Form Text - PRODUCTION or SANDBOX
 *     custrecord_wal_priceupdate_date         - Date/Time - when the attempt was made
 *     custrecord_wal_priceupdate_correlation  - Free-Form Text - WM_QOS.CORRELATION_ID of the PUT call
 *
 * Script parameters:
 *   custscript_wal_base_price_client_id        - Walmart Marketplace API Client ID
 *   custscript_wal_base_price_client_secret    - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_base_price_env              - "PRODUCTION" or "SANDBOX" -- fixed per deployment,
 *                                                not user-selectable on the form
 */
define(
    ['N/ui/serverWidget', 'N/record', 'N/runtime', 'N/https', 'N/encode', 'N/log', 'N/crypto/random'],
    (serverWidget, record, runtime, https, encode, log, random) => {

        const BASE_URLS = {
            PRODUCTION: 'https://marketplace.walmartapis.com',
            SANDBOX: 'https://sandbox.walmartapis.com'
        };

        // This project only sells on Walmart US Marketplace.
        const CURRENCY = 'USD';

        // This Suitelet only ever updates the BASE price.
        const PRICE_TYPE = 'BASE';

        const PRICE_UPDATE_RECORD = {
            TYPE: 'customrecord_wal_base_price_updates',
            FIELDS: {
                SKU: 'custrecord_wal_priceupdate_sku',
                PRICE: 'custrecord_wal_priceupdate_new_price',
                OLD_PRICE: 'custrecord_wal_priceupdate_old_price',
                PRICE_TYPE: 'custrecord_wal_priceupdate_type',
                STATUS: 'custrecord_wal_priceupdate_status',
                RESPONSE: 'custrecord_wal_priceupdate_response',
                ENVIRONMENT: 'custrecord_wal_priceupdate_env',
                DATE: 'custrecord_wal_priceupdate_date',
                CORRELATION_ID: 'custrecord_wal_priceupdate_correlation'
            }
        };

        const UPDATE_STATUS = {
            SUCCESS: 'SUCCESS',
            ERROR: 'ERROR'
        };

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

        /**
         * PRODUCTION: PUT /v3/price -- update one SKU's BASE price.
         * Docs: developer.walmart.com/us-marketplace/reference/updateprice
         *
         * SANDBOX: PUT /v1/simulations/items/{sku} instead ("Update an Item,"
         * developer.walmart.com/us-marketplace/reference/updateanitem-1).
         * @param {Object} params
         * @param {string} params.accessToken
         * @param {string} params.baseUrl
         * @param {string} params.sku
         * @param {number} params.amount
         * @param {string} params.correlationId
         * @param {string} params.environment
         * @returns {Object} parsed Walmart response body
         */
        function updatePrice(params) {
            const { accessToken, baseUrl, sku, amount, correlationId, environment } = params;
            const isSandbox = environment !== 'PRODUCTION';

            const response = isSandbox
                ? https.put({
                    url: `${baseUrl}/v1/simulations/items/${encodeURIComponent(sku)}`,
                    body: JSON.stringify({
                        sku,
                        price: { amount, currency: CURRENCY }
                    }),
                    headers: {
                        'WM_SEC.ACCESS_TOKEN': accessToken,
                        'WM_QOS.CORRELATION_ID': correlationId,
                        'WM_SVC.NAME': 'Walmart Marketplace',
                        'WM_SANDBOX': 'v2',
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    }
                })
                : https.put({
                    url: `${baseUrl}/v3/price`,
                    body: JSON.stringify({
                        sku,
                        pricing: [{
                            currentPrice: { amount, currency: CURRENCY },
                            currentPriceType: PRICE_TYPE
                        }]
                    }),
                    headers: {
                        'WM_SEC.ACCESS_TOKEN': accessToken,
                        'WM_QOS.CORRELATION_ID': correlationId,
                        'WM_SVC.NAME': 'Walmart Marketplace',
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    }
                });

            if (response.code !== 200) {
                throw new Error(`Walmart price update failed (${response.code}): ${response.body}`);
            }
            const parsed = JSON.parse(response.body);

            // A 200 doesn't guarantee a clean update -- Walmart's response shape
            // includes an `errors` array even on success (e.g. partial/warning
            // cases), so surface it rather than only trusting the status code.
            if (Array.isArray(parsed.errors) && parsed.errors.length) {
                throw new Error(`Walmart price update returned errors despite ${response.code}: ${JSON.stringify(parsed.errors)}`);
            }
            return parsed;
        }

        /**
         * Extracts a price amount from either shape getCurrentItemDetails()
         * might return, both per Walmart's docs example responses:
         *   PRODUCTION (GET /v3/items/{sku}):
         *     { ItemResponse: [ { ..., price: { currency, amount } } ], totalItems }
         *   SANDBOX (GET /v1/simulations/items/{sku}, a flat SellerItem,
         *     not array-wrapped):
         *     { sku, productName, productType, condition, price: { currency, amount } }
         * The third candidate is a defensive fallback only -- returns
         * undefined, never throws, if nothing matches. Neither shape breaks
         * price out by type (BASE/REDUCED/CLEARANCE) -- this
         * Suitelet handles BASE pricing only; GET /v3/promo/sku/{sku}
         * is the endpoint that distinguishes price types, if promo pricing
         * comes back into scope.
         */
        function extractPrice(details) {
            const candidates = [
                details && Array.isArray(details.ItemResponse) && details.ItemResponse[0] && details.ItemResponse[0].price,
                details && details.price,
                details && details.responseRecord && details.responseRecord.price
            ];
            const match = candidates.find((p) => p && typeof p.amount === 'number');
            return match ? match.amount : undefined;
        }

        /**
         * Fetches the SKU's current listing details from Walmart before
         * updating price, purely so the "before" price can be shown
         * alongside "after" (via extractPrice()).
         * updatePrice()'s SANDBOX branch needs nothing else out of this 
         * (PUT /v1/simulations/items/{sku} only requires sku + price.
         * Never throws; a failed/blank lookup just means the caller falls
         * back to an undefined price.
         *
         * @returns {Object|undefined} raw parsed Walmart response, or undefined on failure
         */
        function getCurrentItemDetails(params) {
            const { accessToken, baseUrl, sku, environment, correlationId } = params;
            const isSandbox = environment !== 'PRODUCTION';
            const url = isSandbox
                ? `${baseUrl}/v1/simulations/items/${encodeURIComponent(sku)}`
                : `${baseUrl}/v3/items/${encodeURIComponent(sku)}`;
            try {
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
                if (response.code !== 200) {
                    log.audit({
                        title: `Skipping old-item-details capture (sku=${sku}, correlationId=${correlationId})`,
                        details: `${url} returned ${response.code}: ${response.body}`
                    });
                    return undefined;
                }
                return JSON.parse(response.body);
            } catch (e) {
                log.error({ title: `Old-item-details capture failed (sku=${sku}, correlationId=${correlationId})`, details: e });
                return undefined;
            }
        }

        /** Logged but not thrown on failure -- a tracking-record failure shouldn't mask the update result itself. */
        function recordPriceUpdate(params) {
            const { sku, amount, oldPrice, status, responseText, environment, correlationId } = params;
            try {
                const rec = record.create({ type: PRICE_UPDATE_RECORD.TYPE, isDynamic: false });
                rec.setValue({ fieldId: 'name', value: `${status}-${sku}` });
                rec.setValue({ fieldId: PRICE_UPDATE_RECORD.FIELDS.SKU, value: sku });
                rec.setValue({ fieldId: PRICE_UPDATE_RECORD.FIELDS.PRICE, value: amount });
                if (oldPrice !== undefined) {
                    rec.setValue({ fieldId: PRICE_UPDATE_RECORD.FIELDS.OLD_PRICE, value: oldPrice });
                }
                rec.setValue({ fieldId: PRICE_UPDATE_RECORD.FIELDS.PRICE_TYPE, value: PRICE_TYPE });
                rec.setValue({ fieldId: PRICE_UPDATE_RECORD.FIELDS.STATUS, value: status });
                rec.setValue({ fieldId: PRICE_UPDATE_RECORD.FIELDS.RESPONSE, value: responseText });
                rec.setValue({ fieldId: PRICE_UPDATE_RECORD.FIELDS.ENVIRONMENT, value: environment });
                rec.setValue({ fieldId: PRICE_UPDATE_RECORD.FIELDS.DATE, value: new Date() });
                rec.setValue({ fieldId: PRICE_UPDATE_RECORD.FIELDS.CORRELATION_ID, value: correlationId });
                rec.save();
            } catch (e) {
                log.error({ title: `Failed to record price update tracking (sku=${sku})`, details: e });
            }
        }

        function getScriptParams() {
            const script = runtime.getCurrentScript();
            return {
                clientId: script.getParameter({ name: 'custscript_wal_base_price_client_id' }),
                clientSecret: script.getParameter({ name: 'custscript_wal_base_price_client_secret' }),
                defaultEnvironment: script.getParameter({ name: 'custscript_wal_base_price_env' }) || 'SANDBOX'
            };
        }

        function getBaseUrl(environment) {
            return environment === 'PRODUCTION' ? BASE_URLS.PRODUCTION : BASE_URLS.SANDBOX;
        }

        /**
         * @param {Object} params
         * @param {string} [params.sku] - repopulates the form after an attempt
         * @param {string} [params.action] - 'lookup' or 'update', repopulates the Action dropdown
         * @param {string} [params.newPrice]
         * @param {string} [params.resultText] - result/error message from the last attempt
         */
        function buildForm(params) {
            const form = serverWidget.createForm({
                title: `Walmart Base Price Lookup/Update (${getScriptParams().defaultEnvironment})`
            });

            // Single Action dropdown + one Submit button.
            const actionField = form.addField({
                id: 'custpage_action',
                type: serverWidget.FieldType.SELECT,
                label: 'Action'
            });
            actionField.addSelectOption({ value: 'lookup', text: 'Look Up Price' });
            actionField.addSelectOption({ value: 'update', text: 'Update Price' });
            actionField.defaultValue = params.action || 'lookup';

            const skuField = form.addField({
                id: 'custpage_sku',
                type: serverWidget.FieldType.TEXT,
                label: 'SKU'
            });
            skuField.isMandatory = true;
            if (params.sku) skuField.defaultValue = params.sku;

            const newPriceField = form.addField({
                id: 'custpage_new_price',
                type: serverWidget.FieldType.TEXT,
                label: 'New Base Price (USD) (only required for Update Price)'
            });
            if (params.newPrice) newPriceField.defaultValue = params.newPrice;

            form.addSubmitButton({ label: 'Submit' });

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

            const sku = context.request.parameters.custpage_sku;
            const newPriceRaw = context.request.parameters.custpage_new_price;
            const action = context.request.parameters.custpage_action || 'lookup';
            const doUpdate = action === 'update';

            if (!sku) {
                context.response.writePage(buildForm({ action, newPrice: newPriceRaw, resultText: 'SKU is required.' }));
                return;
            }

            let amount;
            if (doUpdate) {
                const trimmedPrice = (newPriceRaw || '').trim();
                amount = parseFloat(trimmedPrice);
                if (!trimmedPrice || isNaN(amount) || amount <= 0) {
                    context.response.writePage(buildForm({
                        sku,
                        action,
                        newPrice: newPriceRaw,
                        resultText: `New Base Price must be a positive number ("${trimmedPrice}" is not valid).`
                    }));
                    return;
                }
            }

            const { clientId, clientSecret, defaultEnvironment } = getScriptParams();
            if (!clientId || !clientSecret) {
                context.response.writePage(buildForm({
                    sku,
                    action,
                    newPrice: newPriceRaw,
                    resultText: 'Missing custscript_wal_base_price_client_id / custscript_wal_base_price_client_secret script parameters.'
                }));
                return;
            }

            const baseUrl = getBaseUrl(defaultEnvironment);

            let resultText;
            // Reassigned before each Walmart call rather than reusing the
            // token request's ID.
            let correlationId = random.generateUUID();
            let oldPrice;
            try {
                const accessToken = getAccessToken({ clientId, clientSecret, baseUrl, correlationId });

                correlationId = random.generateUUID();
                const details = getCurrentItemDetails({ accessToken, baseUrl, sku, environment: defaultEnvironment, correlationId });
                oldPrice = extractPrice(details);
                const oldPriceText = oldPrice !== undefined ? `$${oldPrice}` : '(could not be determined -- see execution log)';

                if (doUpdate) {
                    correlationId = random.generateUUID();
                    const updated = updatePrice({ accessToken, baseUrl, sku, amount, correlationId, environment: defaultEnvironment });
                    const responseText = JSON.stringify(updated, null, 2);
                    resultText = `Previous BASE price: ${oldPriceText}\n`
                        + `New BASE price: $${amount}\n\n`
                        + `Updated price:\n${responseText}`;
                    recordPriceUpdate({ sku, amount, oldPrice, status: UPDATE_STATUS.SUCCESS, responseText, environment: defaultEnvironment, correlationId });
                } else {
                    resultText = `Current BASE price: ${oldPriceText}`;
                }

                resultText += `\n\ncorrelationId: ${correlationId} (reference this if you need to ask Walmart support about this request)`;
            } catch (e) {
                resultText = `Error: ${e.message}\n\ncorrelationId: ${correlationId}\n\nSee execution log for full request/response details.`;
                log.error({ title: `Price ${doUpdate ? 'update' : 'lookup'} failed (sku=${sku}, correlationId=${correlationId})`, details: e });

                if (doUpdate) {
                    recordPriceUpdate({ sku, amount, oldPrice, status: UPDATE_STATUS.ERROR, responseText: e.message, environment: defaultEnvironment, correlationId });
                }
            }

            context.response.writePage(buildForm({ sku, action, newPrice: newPriceRaw, resultText }));
        };

        return { onRequest };
    }
);
