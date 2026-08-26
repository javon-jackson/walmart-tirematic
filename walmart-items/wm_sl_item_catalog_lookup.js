/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * On-demand read of Walmart's ENTIRE item catalog (not scoped to NetSuite or
 * a SKU list) -- click Fetch and this pages through Walmart's "get all
 * items" endpoint until it stops returning a cursor.
 *
 * SANDBOX uses the simulations API -- GET /v1/simulations/items (no {sku}
 * suffix) -- while PRODUCTION uses GET /v3/items.
 *
 * The simulations endpoint is hit BARE for SANDBOX -- no limit/nextCursor
 * params, since it doesn't take them and returns everything in one
 * response. PRODUCTION's /v3/items still pages via limit/nextCursor (see
 * getItemsPage()), so only PRODUCTION can hit the MAX_PAGES cap below;
 * SANDBOX is always exactly one call.
 *
 * For full raw detail on one or a few specific SKUs, use
 * wm_sl_item_details.js (up to 10 at a time). This script is for "just show
 * me every item Walmart has right now" -- each entry is summarized to a
 * single line (sku/productName/publishedStatus/lifecycleStatus/price)
 * rather than the full raw item, to stay readable and within the Result
 * field's size limit across a whole catalog. The full raw page response is
 * still logged via logHttpResponse() (see wm_sl_item_details.js's header for
 * the "nothing lost" reasoning), so nothing beyond the summary is silently
 * dropped -- just not shown on-screen.
 *
 * SAFETY CAP: MAX_PAGES stops the loop after 200 pages (10,000 items at the
 * max page size) rather than looping unbounded inside one Suitelet request. 
 * If hit, the result says so explicitly (never a silent truncation). Unlike that
 * script, there's currently no Map/Reduce equivalent here that pages the
 * full item catalog across multiple governance cycles -- would need to be
 * built as a follow-up if the cap is routinely hit.
 *
 *
 * Script parameters:
 *   custscript_wal_full_details_client_id - Walmart Marketplace API Client ID
 *   custscript_wal_full_details_secret    - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_full_details_env       - "PRODUCTION" or "SANDBOX" -- fixed per deployment,
 *                                           not user-selectable on the form
 *
 */
define(
    ['N/ui/serverWidget', 'N/runtime', 'N/https', 'N/encode', 'N/log', 'N/crypto/random'],
    (serverWidget, runtime, https, encode, log, random) => {

        const BASE_URLS = {
            PRODUCTION: 'https://marketplace.walmartapis.com',
            SANDBOX: 'https://sandbox.walmartapis.com'
        };

        const ITEMS_PAGE_LIMIT = 50;

        const MAX_PAGES = 200;

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

        function extractItemPrice(item) {
            const candidates = [
                item && item.price,
                item && item.responseRecord && item.responseRecord.price
            ];
            const match = candidates.find((p) => p && typeof p.amount === 'number');
            return match ? `${match.amount} ${match.currency || ''}`.trim() : '';
        }

        /** Never throws -- an unexpected item shape just yields blank fields, not a failed fetch. See file header. */
        function extractItemSummary(item) {
            return {
                sku: (item && item.sku) || '(no sku)',
                productName: (item && item.productName) || '',
                publishedStatus: (item && item.publishedStatus) || '',
                lifecycleStatus: (item && item.lifecycleStatus) || '',
                price: extractItemPrice(item)
            };
        }

        /**
         * Fetches one page of the catalog. SANDBOX hits GET
         * /v1/simulations/items bare (no limit/nextCursor -- it returns
         * everything in one shot); PRODUCTION's GET /v3/items still pages
         * normally via limit/nextCursor.
         * @returns {{ entries: Object[], nextCursor: string|undefined }}
         */
        function getItemsPage(params) {
            const { accessToken, baseUrl, environment, nextCursor, correlationId } = params;
            const isSandbox = environment !== 'PRODUCTION';

            const url = isSandbox
                ? `${baseUrl}/v1/simulations/items`
                : `${baseUrl}/v3/items?limit=${ITEMS_PAGE_LIMIT}`
                    + (nextCursor ? `&nextCursor=${encodeURIComponent(nextCursor)}` : '');

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

            logHttpResponse('Walmart item catalog page response', response, correlationId);
            if (response.code !== 200) {
                throw new Error(`Walmart item catalog fetch failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }

            const parsed = safeJsonParse(response.body, correlationId, 'item catalog page');
            // SANDBOX returns a bare array directly; fall back to the ItemResponse/items wrapper otherwise.
            const items = Array.isArray(parsed) ? parsed : (parsed.ItemResponse || parsed.items || []);

            return {
                entries: items.map(extractItemSummary),
                // SANDBOX takes no paging params, so drop any nextCursor
                // Walmart echoes back rather than re-hitting the bare URL forever.
                nextCursor: isSandbox ? undefined : parsed.nextCursor
            };
        }

        /**
         * Pages through the entire catalog, up to MAX_PAGES pages, reusing
         * one access token across every page (same pattern used throughout
         * this project).
         * @returns {{ entries: Object[], pagesFetched: number, cappedAt: boolean }}
         */
        function getAllWalmartItems(params) {
            const { accessToken, baseUrl, environment, correlationId } = params;
            const entries = [];
            let nextCursor;
            let pagesFetched = 0;
            let cappedAt = false;

            do {
                const page = getItemsPage({ accessToken, baseUrl, environment, nextCursor, correlationId });
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
                clientId: script.getParameter({ name: 'custscript_wal_full_details_client_id' }),
                clientSecret: script.getParameter({ name: 'custscript_wal_full_details_secret' }),
                defaultEnvironment: script.getParameter({ name: 'custscript_wal_full_details_env' }) || 'SANDBOX'
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
            const environment = getScriptParams().defaultEnvironment;
            const form = serverWidget.createForm({
                title: `Walmart Full Item Catalog Lookup (${environment}${environment === 'PRODUCTION' ? '' : ', uses simulations API'})`
            });

            form.addSubmitButton({ label: 'Fetch All Items' });

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
                    resultText: 'Missing custscript_wal_full_details_client_id / custscript_wal_full_details_secret script parameters.'
                }));
                return;
            }

            const baseUrl = getBaseUrl(defaultEnvironment);

            let resultText;
            let correlationId = random.generateUUID();
            try {
                const accessToken = getAccessToken({ clientId, clientSecret, baseUrl, correlationId });

                correlationId = random.generateUUID();
                const { entries, pagesFetched, cappedAt } = getAllWalmartItems({ accessToken, baseUrl, environment: defaultEnvironment, correlationId });

                const summaryLines = entries.map((e) => `  ${e.sku} | ${e.productName} | published=${e.publishedStatus} `
                    + `| lifecycle=${e.lifecycleStatus} | price=${e.price}`);

                resultText = `correlationId: ${correlationId} (reference this if you need to ask Walmart support about this request)\n\n`
                    + `Fetched ${entries.length} item(s) across ${pagesFetched} page(s) from `
                    + `${defaultEnvironment === 'PRODUCTION' ? 'PRODUCTION (/v3/items)' : 'SANDBOX (/v1/simulations/items)'}.\n`
                    + (cappedAt
                        ? `*** Stopped at the ${MAX_PAGES}-page safety cap -- Walmart still had more pages left (more `
                            + 'items exist than are shown below). ***\n'
                        : '')
                    + `\nFor full raw detail on any specific SKU below, use wm_sl_item_details.js (up to 10 at a time).\n\n`
                    + `${summaryLines.join('\n')}`;
            } catch (e) {
                resultText = `Error: ${e.message}\n\ncorrelationId: ${correlationId}\n\nSee execution log for full request/response details.`;
                log.error({ title: `Full item catalog fetch failed (correlationId=${correlationId})`, details: e });
            }

            context.response.writePage(buildForm({ resultText }));
        };

        return { onRequest };
    }
);
