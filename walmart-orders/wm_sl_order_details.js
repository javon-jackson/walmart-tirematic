/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 */
define(
    ['N/ui/serverWidget', 'N/runtime', 'N/https', 'N/encode', 'N/log', 'N/crypto/random'],
    (serverWidget, runtime, https, encode, log, random) => {

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

        function getOrderDetails(params) {
            const { accessToken, baseUrl, lookup: purchaseOrderId, environment, correlationId } = params;

            const url = `${baseUrl}/v3/orders/${encodeURIComponent(purchaseOrderId)}`;
            log.audit({ title: `Walmart order details request (correlationId=${correlationId})`, details: url });

            const response = https.get({
                url,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_QOS.CORRELATION_ID': correlationId,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    ...(environment !== 'PRODUCTION' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'Accept': 'application/json'
                }
            });

            logHttpResponse(`Walmart order details response (purchaseOrderId=${purchaseOrderId})`, response, correlationId);
            if (response.code !== 200) {
                throw new Error(`Walmart order details lookup failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }
            return safeJsonParse(response.body, correlationId, 'order details');
        }

        function getScriptParams() {
            const script = runtime.getCurrentScript();
            return {
                clientId: script.getParameter({ name: 'custscript_wal_orderdetails_client_id' }),
                clientSecret: script.getParameter({ name: 'custscript_wal_orderdetails_secret' }),
                defaultEnvironment: script.getParameter({ name: 'custscript_wal_orderdetails_env' }) || 'SANDBOX'
            };
        }

        function getBaseUrl(environment) {
            return environment === 'PRODUCTION' ? BASE_URLS.PRODUCTION : BASE_URLS.SANDBOX;
        }

        /**
         * @param {Object} params
         * @param {string} [params.lookups] - repopulates the form after a lookup
         * @param {string} [params.resultText] - result/error message from the last lookup
         */
        function buildForm(params) {
            const form = serverWidget.createForm({
                title: `Walmart Order Details Lookup (${getScriptParams().defaultEnvironment})`
            });

            const lookupField = form.addField({
                id: 'custpage_order_lookups',
                type: serverWidget.FieldType.LONGTEXT,
                label: `Purchase Order IDs (one per line, up to ${MAX_ITEMS})`
            });
            lookupField.isMandatory = true;
            if (params.lookups) lookupField.defaultValue = params.lookups;

            form.addSubmitButton({ label: 'Get Order Details' });

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

        function lookupOne(params) {
            const { lookup, accessToken, baseUrl, environment } = params;
            // Fresh correlation ID per purchase order -- each is its own Walmart call.
            const correlationId = random.generateUUID();
            try {
                const details = getOrderDetails({ accessToken, baseUrl, lookup, environment, correlationId });
                return `--- purchaseOrderId=${lookup} ---\n`
                    + `correlationId: ${correlationId} (reference this if you need to ask Walmart support about this item)\n\n`
                    + JSON.stringify(details, null, 2);
            } catch (e) {
                log.error({ title: `Order details lookup failed (lookup=${lookup}, correlationId=${correlationId})`, details: e });
                return `--- "${lookup}" ---\nError: ${e.message}\ncorrelationId: ${correlationId}\n\nSee execution log for full request/response details.`;
            }
        }

        const onRequest = (context) => {
            if (context.request.method !== 'POST') {
                context.response.writePage(buildForm({}));
                return;
            }

            const rawLookups = context.request.parameters.custpage_order_lookups || '';
            const allLookups = rawLookups.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

            if (!allLookups.length) {
                context.response.writePage(buildForm({ resultText: 'Enter at least one purchase order ID.' }));
                return;
            }

            const lookups = allLookups.slice(0, MAX_ITEMS);
            const truncatedNote = allLookups.length > MAX_ITEMS
                ? `Only looking up the first ${MAX_ITEMS} of ${allLookups.length} purchase order IDs entered.\n\n`
                : '';

            const { clientId, clientSecret, defaultEnvironment } = getScriptParams();
            if (!clientId || !clientSecret) {
                context.response.writePage(buildForm({
                    lookups: rawLookups,
                    resultText: 'Missing custscript_wal_orderdetails_client_id / custscript_wal_orderdetails_client_secret script parameters.'
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
                resultText = truncatedNote + sections.join('\n\n');
            } catch (e) {
                resultText = `Error fetching Walmart access token: ${e.message}\n\nSee execution log for full request/response details.`;
                log.error({ title: 'Order details batch lookup failed to authenticate', details: e });
            }

            context.response.writePage(buildForm({ lookups: rawLookups, resultText }));
        };

        return { onRequest };
    }
);
