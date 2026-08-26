/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * On-demand Walmart item retirement: enter a SKU or internal ID, and this
 * calls DELETE /v3/items/{sku} against whichever environment THIS
 * deployment's custscript_wal_retire_env parameter is set to (see Script
 * parameters below).
 *
 * Manual, one-item-at-a-time tool. An automated script that watches for
 * items going Inactive in NetSuite and retires them on Walmart on a
 * schedule is a natural follow-up, not built here.
 *
 * On success, writes a row to the customrecord_wal_retired_items tracking
 * record.
 *
 *
 * Script parameters:
 *   custscript_wal_retire_client_id       - Walmart Marketplace API Client ID
 *   custscript_wal_retire_client_secret   - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_retire_env             - "PRODUCTION" or "SANDBOX" -- fixed per deployment,
 *                                           not user-selectable on the form
 */
define(
    ['N/ui/serverWidget', 'N/record', 'N/runtime', 'N/https', 'N/encode', 'N/search', 'N/log', 'N/crypto/random'],
    (serverWidget, record, runtime, https, encode, search, log, random) => {

        const BASE_URLS = {
            PRODUCTION: 'https://marketplace.walmartapis.com',
            SANDBOX: 'https://sandbox.walmartapis.com'
        };

        const RETIREMENT_RECORD = {
            TYPE: 'customrecord_wal_retired_items',
            FIELDS: {
                SKU: 'custrecord_wal_retired_item_sku',
                STATUS: 'custrecord_wal_retired_item_status',
                RESPONSE: 'custrecord_wal_retired_item_response',
                ENVIRONMENT: 'custrecord_wal_retired_item_env',
                DATE: 'custrecord_wal_retired_item_date',
                CORRELATION_ID: 'custrecord_wal_retired_item_correlation'
            }
        };

        const RETIREMENT_STATUS = {
            SUCCESS: 'SUCCESS',
            ERROR: 'ERROR'
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

        /** Same OAuth client-credentials flow as wm_mr_tire_upload.js / wm_sl_feed_status.js. */
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

        /** Retires one item on Walmart -- per-SKU DELETE, no feed envelope needed (unlike MP_ITEM uploads). */
        function retireItem(params) {
            const { accessToken, baseUrl, sku, correlationId } = params;

            const url = `${baseUrl}/v3/items/${encodeURIComponent(sku)}`;
            log.audit({ title: `Walmart retire item request (correlationId=${correlationId})`, details: url });

            const response = https.delete({
                url,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_QOS.CORRELATION_ID': correlationId,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'Accept': 'application/json'
                }
            });

            logHttpResponse(`Walmart retire item response (sku=${sku})`, response, correlationId);
            if (response.code !== 200) {
                throw new Error(`Walmart item retirement failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }
            return safeJsonParse(response.body, correlationId, 'retire item');
        }

        function getScriptParams() {
            const script = runtime.getCurrentScript();
            return {
                clientId: script.getParameter({ name: 'custscript_wal_retire_client_id' }),
                clientSecret: script.getParameter({ name: 'custscript_wal_retire_client_secret' }),
                defaultEnvironment: script.getParameter({ name: 'custscript_wal_retire_env' }) || 'SANDBOX'
            };
        }

        function getBaseUrl(environment) {
            return environment === 'PRODUCTION' ? BASE_URLS.PRODUCTION : BASE_URLS.SANDBOX;
        }

        /**
         * Looks up an item directly by SKU or internal ID -- no dependency
         * on the upload saved search, since this tool should work for any
         * item. Same numeric-vs-text branch as wm_sl_test_upload.js's findItem().
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

        /** Logged but not thrown on failure -- a tracking-record failure shouldn't mask the retire result itself. */
        function recordRetirement(params) {
            const { sku, status, responseText, environment, correlationId } = params;
            try {
                const rec = record.create({ type: RETIREMENT_RECORD.TYPE, isDynamic: false });
                rec.setValue({ fieldId: 'name', value: `${status}-${sku}` });
                rec.setValue({ fieldId: RETIREMENT_RECORD.FIELDS.SKU, value: sku });
                rec.setValue({ fieldId: RETIREMENT_RECORD.FIELDS.STATUS, value: status });
                rec.setValue({ fieldId: RETIREMENT_RECORD.FIELDS.RESPONSE, value: responseText });
                rec.setValue({ fieldId: RETIREMENT_RECORD.FIELDS.ENVIRONMENT, value: environment });
                rec.setValue({ fieldId: RETIREMENT_RECORD.FIELDS.DATE, value: new Date() });
                rec.setValue({ fieldId: RETIREMENT_RECORD.FIELDS.CORRELATION_ID, value: correlationId });
                rec.save();
            } catch (e) {
                log.error({ title: `Failed to record item retirement tracking (sku=${sku})`, details: e });
            }
        }

        /**
         * @param {Object} params
         * @param {string} [params.lookup] - repopulates the form after a lookup
         * @param {string} [params.resultText] - result/error message from the last attempt
         */
        function buildForm(params) {
            const form = serverWidget.createForm({
                title: `Walmart Item Retirement (${getScriptParams().defaultEnvironment})`
            });

            const lookupField = form.addField({
                id: 'custpage_item_lookup',
                type: serverWidget.FieldType.TEXT,
                label: 'Item SKU or Internal ID'
            });
            lookupField.isMandatory = true;
            if (params.lookup) lookupField.defaultValue = params.lookup;

            form.addSubmitButton({ label: 'Retire Item' });

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

            const lookup = context.request.parameters.custpage_item_lookup;

            if (!lookup) {
                context.response.writePage(buildForm({ resultText: 'Enter an item SKU or internal ID.' }));
                return;
            }

            const { clientId, clientSecret, defaultEnvironment } = getScriptParams();
            if (!clientId || !clientSecret) {
                context.response.writePage(buildForm({
                    lookup,
                    resultText: 'Missing custscript_wal_retire_client_id / custscript_wal_retire_client_secret script parameters.'
                }));
                return;
            }

            const baseUrl = getBaseUrl(defaultEnvironment);

            let resultText;
            let sku;
            // Reassigned before each Walmart call so that if a call fails, the
            // catch block below logs the ID that call actually used.
            let correlationId = random.generateUUID();
            try {
                const item = findItem(lookup);
                if (!item) {
                    resultText = `No item found matching "${lookup}".`;
                    context.response.writePage(buildForm({ lookup, resultText }));
                    return;
                }
                sku = item.sku;

                const accessToken = getAccessToken({ clientId, clientSecret, baseUrl, correlationId });
                correlationId = random.generateUUID();
                const response = retireItem({ accessToken, baseUrl, sku, correlationId });
                const responseText = JSON.stringify(response, null, 2);

                recordRetirement({ sku, status: RETIREMENT_STATUS.SUCCESS, responseText, environment: defaultEnvironment, correlationId });

                resultText = `correlationId: ${correlationId} (reference this if you need to ask Walmart support about this item)\n\n`
                    + `Retired sku=${sku} (item #${item.id}).\n\n`
                    + responseText;
            } catch (e) {
                resultText = `Error: ${e.message}\n\ncorrelationId: ${correlationId}\n\nSee execution log for full request/response details.`;
                log.error({ title: `Item retirement failed (lookup=${lookup}, correlationId=${correlationId})`, details: e });
                if (sku) {
                    recordRetirement({ sku, status: RETIREMENT_STATUS.ERROR, responseText: e.message, environment: defaultEnvironment, correlationId });
                }
            }

            context.response.writePage(buildForm({ lookup, resultText }));
        };

        return { onRequest };
    }
);
