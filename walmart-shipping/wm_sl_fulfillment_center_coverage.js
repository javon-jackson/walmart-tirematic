/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * 
 * Lookup the geographic coverage area associated with each fulfillment center
 * for our Walmart Sellers account.
 * 
 * Script parameters:
 *   custscript_wal_ffc_coverage_client_id      - Walmart Marketplace API Client ID
 *   custscript_wal_ffc_coverage_secret         - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_ffc_coverage_env            - "PRODUCTION" or "SANDBOX" -- fixed per deployment,
 *                                              not user-selectable on the form 
 */
define(
    ['N/ui/serverWidget', 'N/runtime', 'N/https', 'N/encode', 'N/log', 'N/crypto/random'],
    (serverWidget, runtime, https, encode, log, random) => {
        const BASE_URLS = {
            PRODUCTION: 'https://marketplace.walmartapis.com',
            SANDBOX: 'https://sandbox.walmartapis.com'
        };

        const PARAMS = {
            CLIENT_ID: 'custscript_wal_ffc_coverage_client_id',
            CLIENT_SECRET: 'custscript_wal_ffc_coverage_secret',
            ENVIRONMENT: 'custscript_wal_ffc_coverage_env'
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

        function getFulfillmentCenterCoverage(params) {
            const { clientId, clientSecret, environment, baseUrl, accessToken, correlationId } = params;

            const response = https.get({
                url: `${baseUrl}/v3/settings/shipping/shipnodes/coverage`,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_QOS.CORRELATION_ID': correlationId,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'Accept': 'application/json'
                }
            });

            if (response.code !== 200) {
                throw new Error(`Walmart fulfillment center coverage lookup failed (${response.code}): ${response.body}`);
            }
            return JSON.parse(response.body);
        }

        function buildForm(params) {
            const form = serverWidget.createForm({
                title: `Walmart Fulfillment Center Coverage (${getScriptParams().defaultEnvironment})`
            });

            form.addSubmitButton({ label: 'Lookup' });

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
            if (context.request.method !== 'POST'){
                context.response.writePage(buildForm({}));
                return;
            }
            
            const { clientId, clientSecret, defaultEnvironment } = getScriptParams();

            const baseUrl = getBaseUrl(defaultEnvironment);

            let resultText;
            let correlationId = random.generateUUID();

            try {
                const accessToken = getAccessToken({ clientId, clientSecret, baseUrl, correlationId });
                
                correlationId = random.generateUUID();

                // Array of { shipNode, shipNodeName, coverageArea}
                const response = getFulfillmentCenterCoverage({ clientId, clientSecret, environment: defaultEnvironment, baseUrl, accessToken, correlationId });
                
                const detailBlocks = response.map((coverage) =>{ 
                    const coverageArea = Array.isArray(coverage.coverageArea) && coverage.coverageArea.length
                        ? coverage.coverageArea.join(', ')
                        : 'No assigned region coverage';

                    return `---------\n Name: ${coverage.shipNodeName || 'Unnamed'}\n ID: ${coverage.shipNode || 'No ID'}\n Coverage: ${coverageArea}\n---------` 
                });
                resultText = `correlationId: ${correlationId} (reference this if you need to ask Walmart support about this request)\n\n`
                    + detailBlocks.join('\n\n');

            } catch(e) {
                resultText = `Error: ${e.message}\n\ncorrelationId: ${correlationId}\n\nSee execution log for full request/response details.`;
                log.error({ title: `Walmart fulfillment center coverage lookup failed (correlationId=${correlationId})`, details: e });
            }

            context.response.writePage(buildForm({ resultText }));
        }

        return { onRequest };
});