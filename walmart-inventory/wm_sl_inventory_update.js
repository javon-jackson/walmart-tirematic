/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * On-demand Walmart Marketplace inventory lookup/update. Enter a SKU, pick
 * an Action ("Look Up Quantity" -- GET /v3/inventory, read-only -- or
 * "Update Quantity" -- PUT /v3/inventory, requires New Quantity), click
 * Submit -- against whichever environment THIS deployment's
 * custscript_wal_invupdate_env parameter is set to.
 *
 * On Update, getCurrentQuantity() fetches the SKU's current quantity via
 * GET /v3/inventory right before the PUT, to show a "before" value
 * alongside "after" -- never blocks the update if that lookup fails; the
 * old quantity just comes back blank in the result text/tracking record.
 *
 * Every update attempt (success or failure) is written to the
 * customrecord_wal_inv_updates tracking record: an audit trail of who changed 
 * what SKU to what quantity, when, and with what result.
 *
 *
 * Custom record:
 *   Record type ID: customrecord_wal_inv_updates
 *   Fields:
 *     custrecord_wal_invupdate_sku          - Free-Form Text - the SKU that was updated
 *     custrecord_wal_invupdate_new_qty      - Integer - the quantity that was requested
 *     custrecord_wal_invupdate_old_qty      - Integer - quantity Walmart reported just before this
 *                                              update (best-effort via GET /v3/inventory -- blank if
 *                                              that lookup failed or didn't match the expected shape)
 *     custrecord_wal_invupdate_status       - Free-Form Text - SUCCESS / ERROR
 *     custrecord_wal_invupdate_response     - Long Text - raw Walmart response (or error message)
 *     custrecord_wal_invupdate_env          - Free-Form Text - PRODUCTION or SANDBOX
 *     custrecord_wal_invupdate_date         - Date/Time - when the attempt was made
 *     custrecord_wal_invupdate_correlation  - Free-Form Text - WM_QOS.CORRELATION_ID of the PUT call
 *
 * Script parameters:
 *   custscript_wal_invupdate_client_id       - Walmart Marketplace API Client ID
 *   custscript_wal_invupdate_client_secret   - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_invupdate_env             - "PRODUCTION" or "SANDBOX" -- fixed per deployment,
 *                                              not user-selectable on the form
 *   custscript_wal_invupdate_ship_node       - Fulfillment center ship node id (optional -- if unset,
 *                                              Walmart uses whatever it considers the default
 *                                              fulfillment center, which may not match the one
 *                                              actually intended once more than one FC exists)
 *
 */
define(
    ['N/ui/serverWidget', 'N/record', 'N/runtime', 'N/https', 'N/encode', 'N/log', 'N/crypto/random'],
    (serverWidget, record, runtime, https, encode, log, random) => {

        const BASE_URLS = {
            PRODUCTION: 'https://marketplace.walmartapis.com',
            SANDBOX: 'https://sandbox.walmartapis.com'
        };

        const QUANTITY_UNIT = 'EACH';

        const INVENTORY_UPDATE_RECORD = {
            TYPE: 'customrecord_wal_inv_updates',
            FIELDS: {
                SKU: 'custrecord_wal_invupdate_sku',
                QUANTITY: 'custrecord_wal_invupdate_new_qty',
                OLD_QUANTITY: 'custrecord_wal_invupdate_old_qty',
                STATUS: 'custrecord_wal_invupdate_status',
                RESPONSE: 'custrecord_wal_invupdate_response',
                ENVIRONMENT: 'custrecord_wal_invupdate_env',
                DATE: 'custrecord_wal_invupdate_date',
                CORRELATION_ID: 'custrecord_wal_invupdate_correlation'
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

        /** GET /v3/inventory?sku= -- current inventory for one SKU. Same as wm_sl_inventory_lookup.js's version. */
        function getInventory(params) {
            const { accessToken, baseUrl, sku, correlationId, environment, shipNode } = params;

            const shipNodeQuery = shipNode ? `&shipNode=${encodeURIComponent(shipNode)}` : '';
            const response = https.get({
                url: `${baseUrl}/v3/inventory?sku=${encodeURIComponent(sku)}${shipNodeQuery}`,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_QOS.CORRELATION_ID': correlationId,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'Accept': 'application/json',
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                }
            });

            if (response.code !== 200) {
                throw new Error(`Walmart inventory lookup failed (${response.code}): ${response.body}`);
            }
            return JSON.parse(response.body);
        }

        /** PUT /v3/inventory -- update one SKU's inventory quantity. */
        function updateInventory(params) {
            const { accessToken, baseUrl, sku, amount, correlationId, environment, shipNode } = params;

            // TODO: Without setting body param inventoryAvailableDate, Walmart treats the inventory as available today.
            const shipNodeQuery = shipNode ? `&shipNode=${encodeURIComponent(shipNode)}` : '';
            const response = https.put({
                url: `${baseUrl}/v3/inventory?sku=${encodeURIComponent(sku)}${shipNodeQuery}`,
                body: JSON.stringify({
                    sku,
                    quantity: { unit: QUANTITY_UNIT, amount }
                }),
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_QOS.CORRELATION_ID': correlationId,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                }
            });

            if (response.code !== 200) {
                throw new Error(`Walmart inventory update failed (${response.code}): ${response.body}`);
            }
            return JSON.parse(response.body);
        }

        /**
         * Current quantity via getInventory(), for the "before" value shown
         * next to "after" on an update. Never throws -- a failed/blank
         * lookup just means the old quantity isn't captured.
         * @returns {number|undefined}
         */
        function getCurrentQuantity(params) {
            const { accessToken, baseUrl, sku, correlationId, environment, shipNode } = params;
            try {
                const details = getInventory({ accessToken, baseUrl, sku, correlationId, environment, shipNode });
                return (details && details.quantity && typeof details.quantity.amount === 'number')
                    ? details.quantity.amount
                    : undefined;
            } catch (e) {
                log.error({ title: `Old-quantity capture failed (sku=${sku}, correlationId=${correlationId})`, details: e });
                return undefined;
            }
        }

        /** Logged but not thrown on failure -- a tracking-record failure shouldn't mask the update result itself. */
        function recordInventoryUpdate(params) {
            const { sku, amount, oldQuantity, status, responseText, environment, correlationId } = params;
            try {
                const rec = record.create({ type: INVENTORY_UPDATE_RECORD.TYPE, isDynamic: false });
                rec.setValue({ fieldId: 'name', value: `${status}-${sku}` });
                rec.setValue({ fieldId: INVENTORY_UPDATE_RECORD.FIELDS.SKU, value: sku });
                rec.setValue({ fieldId: INVENTORY_UPDATE_RECORD.FIELDS.QUANTITY, value: amount });
                if (oldQuantity !== undefined) {
                    rec.setValue({ fieldId: INVENTORY_UPDATE_RECORD.FIELDS.OLD_QUANTITY, value: oldQuantity });
                }
                rec.setValue({ fieldId: INVENTORY_UPDATE_RECORD.FIELDS.STATUS, value: status });
                rec.setValue({ fieldId: INVENTORY_UPDATE_RECORD.FIELDS.RESPONSE, value: responseText });
                rec.setValue({ fieldId: INVENTORY_UPDATE_RECORD.FIELDS.ENVIRONMENT, value: environment });
                rec.setValue({ fieldId: INVENTORY_UPDATE_RECORD.FIELDS.DATE, value: new Date() });
                rec.setValue({ fieldId: INVENTORY_UPDATE_RECORD.FIELDS.CORRELATION_ID, value: correlationId });
                rec.save();
            } catch (e) {
                log.error({ title: `Failed to record inventory update tracking (sku=${sku})`, details: e });
            }
        }

        function getScriptParams() {
            const script = runtime.getCurrentScript();
            return {
                clientId: script.getParameter({ name: 'custscript_wal_invupdate_client_id' }),
                clientSecret: script.getParameter({ name: 'custscript_wal_invupdate_client_secret' }),
                defaultEnvironment: (script.getParameter({ name: 'custscript_wal_invupdate_env' }) || 'SANDBOX').toUpperCase(),
                shipNode: script.getParameter({ name: 'custscript_wal_invupdate_ship_node' }) || null
            };
        }

        function getBaseUrl(environment) {
            return environment === 'PRODUCTION' ? BASE_URLS.PRODUCTION : BASE_URLS.SANDBOX;
        }

        /**
         * @param {Object} params
         * @param {string} [params.sku] - repopulates the form after an attempt
         * @param {string} [params.action] - 'lookup' or 'update', repopulates the Action dropdown
         * @param {string} [params.newQuantity]
         * @param {string} [params.resultText] - result/error message from the last attempt
         */
        function buildForm(params) {
            const form = serverWidget.createForm({
                title: `Walmart Inventory Lookup/Update (${getScriptParams().defaultEnvironment})`
            });

            const actionField = form.addField({
                id: 'custpage_action',
                type: serverWidget.FieldType.SELECT,
                label: 'Action'
            });
            actionField.addSelectOption({ value: 'lookup', text: 'Look Up Quantity' });
            actionField.addSelectOption({ value: 'update', text: 'Update Quantity' });
            actionField.defaultValue = params.action || 'lookup';

            const skuField = form.addField({
                id: 'custpage_sku',
                type: serverWidget.FieldType.TEXT,
                label: 'SKU'
            });
            skuField.isMandatory = true;
            if (params.sku) skuField.defaultValue = params.sku;

            const newQuantityField = form.addField({
                id: 'custpage_new_quantity',
                type: serverWidget.FieldType.TEXT,
                label: 'New Quantity (only required for Update Quantity)'
            });
            if (params.newQuantity) newQuantityField.defaultValue = params.newQuantity;

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
            const newQuantityRaw = context.request.parameters.custpage_new_quantity;
            const action = context.request.parameters.custpage_action || 'lookup';
            const doUpdate = action === 'update';

            if (!sku) {
                context.response.writePage(buildForm({ action, newQuantity: newQuantityRaw, resultText: 'SKU is required.' }));
                return;
            }

            let amount;
            if (doUpdate) {
                const trimmedQuantity = (newQuantityRaw || '').trim();
                amount = parseInt(trimmedQuantity, 10);
                if (!trimmedQuantity || isNaN(amount) || amount < 0 || String(amount) !== trimmedQuantity) {
                    context.response.writePage(buildForm({
                        sku,
                        action,
                        newQuantity: newQuantityRaw,
                        resultText: `New Quantity must be a non-negative whole number ("${trimmedQuantity}" is not valid).`
                    }));
                    return;
                }
            }

            const { clientId, clientSecret, defaultEnvironment, shipNode } = getScriptParams();
            if (!clientId || !clientSecret) {
                context.response.writePage(buildForm({
                    sku,
                    action,
                    newQuantity: newQuantityRaw,
                    resultText: 'Missing custscript_wal_invupdate_client_id / custscript_wal_invupdate_client_secret script parameters.'
                }));
                return;
            }

            const baseUrl = getBaseUrl(defaultEnvironment);

            let resultText;
            // Reassigned before each Walmart call rather than reused from
            // the token request.
            let correlationId = random.generateUUID();
            let oldQuantity;
            try {
                const accessToken = getAccessToken({ clientId, clientSecret, baseUrl, correlationId });

                if (doUpdate) {
                    correlationId = random.generateUUID();
                    oldQuantity = getCurrentQuantity({ accessToken, baseUrl, sku, correlationId, environment: defaultEnvironment, shipNode });
                    const oldQuantityText = oldQuantity !== undefined ? oldQuantity : '(could not be determined -- see execution log)';

                    correlationId = random.generateUUID();
                    const updated = updateInventory({ accessToken, baseUrl, sku, amount, correlationId, environment: defaultEnvironment, shipNode });
                    const responseText = JSON.stringify(updated, null, 2);
                    resultText = `Previous quantity: ${oldQuantityText}\n`
                        + `New quantity: ${amount}\n\n`
                        + `Updated inventory:\n${responseText}`;
                    recordInventoryUpdate({ sku, amount, oldQuantity, status: UPDATE_STATUS.SUCCESS, responseText, environment: defaultEnvironment, correlationId });
                } else {
                    correlationId = random.generateUUID();
                    const current = getInventory({ accessToken, baseUrl, sku, correlationId, environment: defaultEnvironment, shipNode });
                    resultText = `Current inventory:\n${JSON.stringify(current, null, 2)}`;
                }

                resultText += `\n\ncorrelationId: ${correlationId} (reference this if you need to ask Walmart support about this request)`;
            } catch (e) {
                resultText = `Error: ${e.message}\n\ncorrelationId: ${correlationId}\n\nSee execution log for full request/response details.`;
                log.error({ title: `Inventory ${doUpdate ? 'update' : 'lookup'} failed (sku=${sku}, correlationId=${correlationId})`, details: e });

                if (doUpdate) {
                    recordInventoryUpdate({ sku, amount, oldQuantity, status: UPDATE_STATUS.ERROR, responseText: e.message, environment: defaultEnvironment, correlationId });
                }
            }

            context.response.writePage(buildForm({ sku, action, newQuantity: newQuantityRaw, resultText }));
        };

        return { onRequest };
    }
);
