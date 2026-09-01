/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * On-demand read of Walmart's ENTIRE inventory catalog. 
 * Click Fetch, and this pages (against whichever environment
 * THIS deployment's custscript_wal_full_invlkp_env parameter is set to) through GET
 * /v3/inventories (limit=50 + nextCursor) until Walmart stops returning a
 * cursor.
 *
 *
 * SAFETY CAP: MAX_PAGES stops the loop after 200 pages (10,000 SKUs at max
 * page size) instead of looping unbounded inside one Suitelet request.
 *
 *
 * Script parameters:
 *   custscript_wal_full_invlkp_client_id       - Walmart Marketplace API Client ID
 *   custscript_wal_full_invlkp_client_secret   - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_full_invlkp_env             - "PRODUCTION" or "SANDBOX" -- fixed per deployment,
 *                                                not user-selectable on the form
 *
 */
define(
    ['N/ui/serverWidget', 'N/runtime', 'N/https', 'N/encode', 'N/log', 'N/crypto/random'],
    (serverWidget, runtime, https, encode, log, random) => {

        const BASE_URLS = {
            PRODUCTION: 'https://marketplace.walmartapis.com',
            SANDBOX: 'https://sandbox.walmartapis.com'
        };

        // Walmart's documented max page size for GET /v3/inventories.
        const INVENTORIES_PAGE_LIMIT = 50;

        // See file header. 200 pages * 50/page = 10,000 SKUs.
        const MAX_PAGES = 200;

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
         * Fetches one page of Walmart's full inventory catalog.
         * @returns {{ entries: {sku: string, quantity: number}[], nextCursor: string|undefined }}
         */
        function getInventoriesPage(params) {
            const { accessToken, baseUrl, nextCursor, correlationId, environment } = params;

            const url = `${baseUrl}/v3/inventories?limit=${INVENTORIES_PAGE_LIMIT}`
                + (nextCursor ? `&nextCursor=${encodeURIComponent(nextCursor)}` : '');

            const response = https.get({
                url,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_QOS.CORRELATION_ID': correlationId,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'Accept': 'application/json'
                }
            });

            if (response.code !== 200) {
                throw new Error(`Walmart bulk inventory fetch failed (${response.code}): ${response.body}`);
            }

            const parsed = JSON.parse(response.body);
            const inventories = (parsed.elements && parsed.elements.inventories) || [];

            const entries = inventories.map((entry) => ({
                sku: entry.sku,
                quantity: (entry.nodes || []).reduce((sum, node) => {
                    return sum + ((node.availToSellQty && node.availToSellQty.amount) || 0);
                }, 0)
            }));

            return {
                entries,
                nextCursor: parsed.meta && parsed.meta.nextCursor
            };
        }

        /**
         * Pages through Walmart's entire inventory catalog, up to
         * MAX_PAGES, reusing one access token across every page.
         * @returns {{ entries: {sku: string, quantity: number}[], pagesFetched: number, cappedAt: boolean }}
         */
        function getAllWalmartInventory(params) {
            const { accessToken, baseUrl, correlationId, environment } = params;
            const entries = [];
            let nextCursor;
            let pagesFetched = 0;
            let cappedAt = false;

            do {
                const page = getInventoriesPage({ accessToken, baseUrl, nextCursor, correlationId, environment });
                entries.push(...page.entries);
                nextCursor = page.nextCursor;
                pagesFetched++;
                if (nextCursor && pagesFetched >= MAX_PAGES) {
                    cappedAt = true;
                    break;
                }
            } while (nextCursor);

            return { entries, pagesFetched, cappedAt };
        }

        function getScriptParams() {
            const script = runtime.getCurrentScript();
            return {
                clientId: script.getParameter({ name: 'custscript_wal_full_invlkp_client_id' }),
                clientSecret: script.getParameter({ name: 'custscript_wal_full_invlkp_client_secret' }),
                defaultEnvironment: script.getParameter({ name: 'custscript_wal_full_invlkp_env' }) || 'SANDBOX'
            };
        }

        function getBaseUrl(environment) {
            return environment === 'PRODUCTION' ? BASE_URLS.PRODUCTION : BASE_URLS.SANDBOX;
        }

        /**
         * @param {Object} params
         * @param {string} [params.resultText] - result/error message from the last fetch
         */
        function buildForm(params) {
            const form = serverWidget.createForm({
                title: `Walmart Full Inventory Catalog Lookup (${getScriptParams().defaultEnvironment})`
            });

            form.addSubmitButton({ label: 'Fetch All Inventory' });

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

            const { clientId, clientSecret, defaultEnvironment } = getScriptParams();
            if (!clientId || !clientSecret) {
                context.response.writePage(buildForm({
                    resultText: 'Missing custscript_wal_full_invlkp_client_id / custscript_wal_full_invlkp_client_secret script parameters.'
                }));
                return;
            }

            const baseUrl = getBaseUrl(defaultEnvironment);

            let resultText;
            let correlationId = random.generateUUID();
            try {
                const accessToken = getAccessToken({ clientId, clientSecret, baseUrl, correlationId });

                correlationId = random.generateUUID();
                const { entries, pagesFetched, cappedAt } = getAllWalmartInventory({ accessToken, baseUrl, correlationId, environment: defaultEnvironment });

                const summaryLines = entries.map((e) => `  ${e.sku}: ${e.quantity}`);

                resultText = `correlationId: ${correlationId} (reference this if you need to ask Walmart support about this request)\n\n`
                    + `Fetched ${entries.length} SKU(s) across ${pagesFetched} page(s).\n`
                    + (cappedAt
                        ? `*** Stopped at the ${MAX_PAGES}-page safety cap -- Walmart still had more pages left (more `
                            + 'SKUs exist than are shown below). ***\n'
                        : '')
                    + `\n${summaryLines.join('\n')}`;
            } catch (e) {
                resultText = `Error: ${e.message}\n\ncorrelationId: ${correlationId}\n\nSee execution log for full request/response details.`;
                log.error({ title: `Full inventory catalog fetch failed (correlationId=${correlationId})`, details: e });
            }

            context.response.writePage(buildForm({ resultText }));
        };

        return { onRequest };
    }
);
