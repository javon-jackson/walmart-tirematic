/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * Ad hoc lookup of Walmart's "all released orders" -- orders the Walmart
 * Order Management System has finished validating and handed off to the
 * seller for fulfillment.
 *
 * Time range UI: a single "Time Range" dropdown (Last Hour / Last 24 Hours /
 * Last Week / Custom Range) plus From/To date fields that only apply when
 * Custom Range is selected. The From/To fields are always visible (no
 * client script to show/hide them) -- keeping this a single file matches
 * the other suitelets in this folder. A custom "To" date is bumped to
 * 23:59:59.999 before being sent, since a plain DATE field has no time
 * component and midnight would otherwise exclude that entire day's orders.
 *
 * No pagination loop -- this is a manual lookup tool, not a sync job. If
 * more orders exist than Walmart's default page (100), the result text
 * says so via list.meta.totalCount vs. the number actually returned.
 *
 * Script parameters (own script record -- NetSuite param IDs are unique
 * account-wide):
 *   custscript_wal_released_orders_client_id  - Walmart Marketplace API Client ID
 *   custscript_wal_released_orders_secret     - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_released_orders_env        - "SANDBOX" or "PRODUCTION" (defaults to SANDBOX)
 */
define(
    ['N/ui/serverWidget', 'N/runtime', 'N/https', 'N/encode', 'N/format', 'N/log', 'N/crypto/random'],
    (serverWidget, runtime, https, encode, format, log, random) => {

        const BASE_URLS = {
            PRODUCTION: 'https://marketplace.walmartapis.com',
            SANDBOX: 'https://sandbox.walmartapis.com'
        };

        const TIME_RANGES = {
            LAST_HOUR: 'LAST_HOUR',
            LAST_24_HOURS: 'LAST_24_HOURS',
            LAST_WEEK: 'LAST_WEEK',
            CUSTOM: 'CUSTOM'
        };

        const MS_PER_HOUR = 60 * 60 * 1000;

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

        function getReleasedOrders(params) {
            const { accessToken, baseUrl, createdStartDate, createdEndDate, environment, correlationId } = params;

            const queryParams = [
                `createdStartDate=${encodeURIComponent(createdStartDate)}`,
                `createdEndDate=${encodeURIComponent(createdEndDate)}`
            ];
            const url = `${baseUrl}/v3/orders/released?${queryParams.join('&')}`;
            log.audit({ title: `Walmart released orders request (correlationId=${correlationId})`, details: url });

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

            logHttpResponse('Walmart released orders response', response, correlationId);
            if (response.code !== 200) {
                throw new Error(`Walmart released orders lookup failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }
            return safeJsonParse(response.body, correlationId, 'released orders');
        }

        function getScriptParams() {
            const script = runtime.getCurrentScript();
            return {
                clientId: script.getParameter({ name: 'custscript_wal_released_orders_client_id' }),
                clientSecret: script.getParameter({ name: 'custscript_wal_released_orders_secret' }),
                defaultEnvironment: script.getParameter({ name: 'custscript_wal_released_orders_env' }) || 'SANDBOX'
            };
        }

        function getBaseUrl(environment) {
            return environment === 'PRODUCTION' ? BASE_URLS.PRODUCTION : BASE_URLS.SANDBOX;
        }

        /** Parses a NetSuite DATE field's raw string using the user's date format preference. */
        function parseDateField(rawValue) {
            return format.parse({ value: rawValue, type: format.Type.DATE });
        }

        /**
         * Walmart's documented format is "2020-03-16T10:30:15Z" -- no
         * milliseconds. JS's toISOString() always includes them
         * ("...T10:30:15.396Z"), which Walmart's endpoint rejects with
         * INVALID_REQUEST.GMP_ORDER_API / "Invalid Date format value".
         */
        function toWalmartDateString(date) {
            return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
        }

        /**
         * Resolves the dropdown + optional custom dates into the
         * createdStartDate/createdEndDate strings Walmart expects.
         */
        function computeDateRange(params) {
            const { timeRange, fromDateRaw, toDateRaw } = params;
            const now = new Date();

            switch (timeRange) {
                case TIME_RANGES.LAST_HOUR:
                    return { createdStartDate: toWalmartDateString(new Date(now.getTime() - MS_PER_HOUR)), createdEndDate: toWalmartDateString(now) };
                case TIME_RANGES.LAST_24_HOURS:
                    return { createdStartDate: toWalmartDateString(new Date(now.getTime() - 24 * MS_PER_HOUR)), createdEndDate: toWalmartDateString(now) };
                case TIME_RANGES.LAST_WEEK:
                    return { createdStartDate: toWalmartDateString(new Date(now.getTime() - 7 * 24 * MS_PER_HOUR)), createdEndDate: toWalmartDateString(now) };
                case TIME_RANGES.CUSTOM: {
                    if (!fromDateRaw || !toDateRaw) {
                        throw new Error('Custom Range requires both a From Date and a To Date.');
                    }
                    const fromDate = parseDateField(fromDateRaw);
                    const toDate = parseDateField(toDateRaw);
                    toDate.setHours(23, 59, 59, 999); // inclusive of the whole "To" day
                    if (fromDate > toDate) {
                        throw new Error('From Date must be on or before To Date.');
                    }
                    return { createdStartDate: toWalmartDateString(fromDate), createdEndDate: toWalmartDateString(toDate) };
                }
                default:
                    throw new Error(`Unknown time range: ${timeRange}`);
            }
        }

        /**
         * @param {Object} params
         * @param {string} [params.timeRange] - repopulates the dropdown after a lookup
         * @param {string} [params.fromDate] - repopulates the From Date field
         * @param {string} [params.toDate] - repopulates the To Date field
         * @param {string} [params.resultText] - result/error message from the last lookup
         */
        function buildForm(params) {
            const form = serverWidget.createForm({
                title: `Walmart Released Orders (${getScriptParams().defaultEnvironment})`
            });

            const timeRangeField = form.addField({
                id: 'custpage_time_range',
                type: serverWidget.FieldType.SELECT,
                label: 'Time Range'
            });
            timeRangeField.addSelectOption({ value: TIME_RANGES.LAST_HOUR, text: 'Last Hour' });
            timeRangeField.addSelectOption({ value: TIME_RANGES.LAST_24_HOURS, text: 'Last 24 Hours' });
            timeRangeField.addSelectOption({ value: TIME_RANGES.LAST_WEEK, text: 'Last Week' });
            timeRangeField.addSelectOption({ value: TIME_RANGES.CUSTOM, text: 'Custom Range (use From/To Date below)' });
            timeRangeField.defaultValue = params.timeRange || TIME_RANGES.LAST_24_HOURS;

            const fromDateField = form.addField({
                id: 'custpage_from_date',
                type: serverWidget.FieldType.DATE,
                label: 'From Date (Custom Range only)'
            });
            if (params.fromDate) fromDateField.defaultValue = params.fromDate;

            const toDateField = form.addField({
                id: 'custpage_to_date',
                type: serverWidget.FieldType.DATE,
                label: 'To Date (Custom Range only)'
            });
            if (params.toDate) toDateField.defaultValue = params.toDate;

            form.addSubmitButton({ label: 'Get Released Orders' });

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

            const timeRange = context.request.parameters.custpage_time_range;
            const fromDate = context.request.parameters.custpage_from_date;
            const toDate = context.request.parameters.custpage_to_date;
            const formState = { timeRange, fromDate, toDate };

            const { clientId, clientSecret, defaultEnvironment } = getScriptParams();
            if (!clientId || !clientSecret) {
                context.response.writePage(buildForm({
                    ...formState,
                    resultText: 'Missing custscript_wal_released_orders_client_id / custscript_wal_released_orders_secret script parameters.'
                }));
                return;
            }

            const baseUrl = getBaseUrl(defaultEnvironment);
            const correlationId = random.generateUUID();
            let resultText;
            try {
                const { createdStartDate, createdEndDate } = computeDateRange({ timeRange, fromDateRaw: fromDate, toDateRaw: toDate });
                const accessToken = getAccessToken({ clientId, clientSecret, baseUrl, correlationId });
                const released = getReleasedOrders({ accessToken, baseUrl, createdStartDate, createdEndDate, environment: defaultEnvironment, correlationId });

                const orders = (released.list && released.list.elements && released.list.elements.order) || [];
                const meta = (released.list && released.list.meta) || {};
                const truncatedNote = typeof meta.totalCount === 'number' && meta.totalCount > orders.length
                    ? `NOTE: ${meta.totalCount} orders matched, only ${orders.length} returned in this page (limit=${meta.limit}). Narrow the time range or add pagination to see the rest.\n\n`
                    : '';

                resultText = `Queried ${createdStartDate} .. ${createdEndDate}\n`
                    + `correlationId: ${correlationId} (reference this if you need to ask Walmart support about this request)\n\n`
                    + truncatedNote
                    + `${orders.length} order(s) returned:\n\n`
                    + JSON.stringify(released, null, 2);
            } catch (e) {
                resultText = `Error: ${e.message}\n\ncorrelationId: ${correlationId}\n\nSee execution log for full request/response details.`;
                log.error({ title: `Released orders lookup failed (correlationId=${correlationId})`, details: e });
            }

            context.response.writePage(buildForm({ ...formState, resultText }));
        };

        return { onRequest };
    }
);