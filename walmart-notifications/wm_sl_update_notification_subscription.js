/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * Ops tool for looking up and updating Walmart Marketplace notification (webhook)
 * subscriptions. Enter a Subscription ID, pick an Action ("Look Up" -- GET
 * /v3/webhooks/subscriptions, read-only -- or "Update" -- PATCH
 * /v3/webhooks/subscriptions/{subscriptionId}), click Submit -- against whichever
 * environment THIS deployment's custscript_wal_notifsub_upd_env parameter is set to.
 *
 * Look Up: Subscription ID is optional -- leave it blank to list every subscription
 * (optionally narrowed by the Event Type and/or Status filters instead). Enter a
 * Subscription ID to fetch just that one.
 *
 * Update: Subscription ID is required (it's a path parameter Walmart's endpoint
 * needs, never sent in the body). Event Type / Event URL / Status are all optional
 * -- only whichever of those three is actually filled in gets sent to Walmart, since
 * this is a partial-patch endpoint; anything left blank keeps its current value on
 * Walmart's side. Picking a new Event Type also sends its matching eventVersion and
 * resourceName automatically, from a closed EVENT_TYPES lookup -- there's no way to
 * submit a mismatched eventType/resourceName pairing.
 * Right before the PATCH, this also does a best-effort GET for that Subscription ID
 * to show a "before" state next to "after" -- never blocks the update if that lookup
 * fails or finds nothing.
 *
 *
 * Custom record: reuses customrecord_wal_notif_subs -- only written on Update, never on Look Up.
 *
 * Script parameters:
 *   custscript_wal_notifsub_upd_client_id  - Walmart Marketplace API Client ID
 *   custscript_wal_notifsub_upd_secret     - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_notifsub_upd_env        - "PRODUCTION" or "SANDBOX"
 */
define(
    ['N/record', 'N/runtime', 'N/https', 'N/encode', 'N/log', 'N/crypto/random', 'N/ui/serverWidget', 'N/ui/message', 'N/url'],
    (record, runtime, https, encode, log, random, serverWidget, message, url) => {

        const BASE_URLS = {
            PRODUCTION: 'https://marketplace.walmartapis.com',
            SANDBOX: 'https://sandbox.walmartapis.com'
        };

        const PARAMS = {
            CLIENT_ID: 'custscript_wal_notifsub_upd_client_id',
            CLIENT_SECRET: 'custscript_wal_notifsub_upd_secret',
            ENVIRONMENT: 'custscript_wal_notifsub_upd_env'
        };

        // https://developer.walmart.com/us-marketplace/reference/geteventtypes
        const EVENT_TYPES = [
            { eventType: 'INTENT_TO_CANCEL_ESPRO', resourceName: 'ESPRO', eventVersion: 'V1', description: 'Notification for Intent to Cancel orders- testing' },
            { eventType: 'TEST_EVENT_SUBSCRIPTION_CASE', resourceName: 'ESPROS', eventVersion: 'V1', description: 'test' },
            { eventType: 'SELLER_PERFORMANCE_NOTIFICATIONS', resourceName: 'FEEDS', eventVersion: 'V1', description: 'Webhook event for various seller performance notifications including late/cancelled deliveries, seller KPI scores, etc' },
            { eventType: 'ASSORTMENT_GROWTH_RECOMMENDATIONS', resourceName: 'Growth', eventVersion: 'V1', description: 'Receive notification for new assortment recommendations' },
            { eventType: 'INVENTORY_OOS', resourceName: 'INVENTORY', eventVersion: 'V1', description: 'Notification for inventory out of stock' },
            { eventType: 'OFFER_PUBLISHED', resourceName: 'ITEM', eventVersion: 'V1', description: 'Notification for published offers' },
            { eventType: 'OFFER_UNPUBLISHED', resourceName: 'ITEM', eventVersion: 'V1', description: 'Notification for unpublished offers' },
            { eventType: 'SELLER_PERFORMANCE_ALARMS', resourceName: 'ITEMS', eventVersion: 'V1', description: 'Webhook event for information about late or cancelled deliveries' },
            { eventType: 'SELLER_PERFORMANCE_REPORT', resourceName: 'ITEMS', eventVersion: 'V1', description: 'Webhook event for information on seller\'s the KPI scores' },
            { eventType: 'DRIVER_STATUS', resourceName: 'ORDER', eventVersion: 'V1', description: 'DRIVER STATUS' },
            { eventType: 'DSV_CARRIER_EDD_UPDATE', resourceName: 'ORDER', eventVersion: 'V1', description: 'DSV CARRIER EDD UPDATE' },
            { eventType: 'INTENT_TO_CANCEL', resourceName: 'ORDER', eventVersion: 'V1', description: 'Notification for Intent to Cancel orders' },
            { eventType: 'MCS_RETURN_ORDER_STATUS_UPDATE', resourceName: 'ORDER', eventVersion: 'V1', description: 'Event to get return order status updates for MCS Orders' },
            { eventType: 'ORDER_SHIPMENT_UPDATE', resourceName: 'ORDER', eventVersion: 'V1', description: 'Event to get Order Shipment updates for MCS Orders' },
            { eventType: 'ORDER_STATUS_UPDATE', resourceName: 'ORDER', eventVersion: 'V1', description: 'Event to get Order status updates for MCS Orders' },
            { eventType: 'ORDER_UPDATES', resourceName: 'ORDER', eventVersion: 'V1', description: 'Consolidate webhook events for various order notifications' },
            { eventType: 'PO_CREATED', resourceName: 'ORDER', eventVersion: 'V1', description: 'Notification for new purchase order created' },
            { eventType: 'PO_LINE_AUTOCANCELLED', resourceName: 'ORDER', eventVersion: 'V1', description: 'Notification for purchase order line auto-cancelled' },
            { eventType: 'BUY_BOX_CHANGED', resourceName: 'PRICE', eventVersion: 'V1', description: 'Notification for change in buy box' },
            { eventType: 'REPORT_STATUS', resourceName: 'REPORTS', eventVersion: 'V1', description: 'Notification when a report is successfully processed or results in error' },
            { eventType: 'MA_ORDER_CANCELLED_UPDATES', resourceName: 'RXO', eventVersion: 'V1', description: 'Receive a notification for RXO preadvice webhooks events' },
            { eventType: 'MA_ORDER_PREADVICE_UPDATES', resourceName: 'RXO', eventVersion: 'V1', description: 'Receive a notification for RXO preadvice webhooks events' },
            { eventType: 'MA_ORDER_UPDATES', resourceName: 'RXO', eventVersion: 'V1', description: 'Receive a notification for RXO webhooks events' },
            { eventType: 'MA_ORDER_UPDATES_ANCHOR', resourceName: 'RXO', eventVersion: 'V1', description: 'This event is only used to differentiate the subscriptions for the ANCHOR PO, they will still be delivered via MA_ORDER_UPDATES' },
            { eventType: 'RETURN_CREATED', resourceName: 'ReturnsAndRefunds', eventVersion: 'V1', description: 'Receive a notification when new return(s) are initiated for Seller Fulfilled Item(s)' },
            { eventType: 'RETURN_DELIVERED', resourceName: 'ReturnsAndRefunds', eventVersion: 'V1', description: 'Receive a notification when returned items are delivered in the Return Center for Seller Fulfilled Item(s)' },
            { eventType: 'RETURN_INVOICED', resourceName: 'ReturnsAndRefunds', eventVersion: 'V1', description: 'Receive a notification when a refund is issued for Seller Fulfilled Item(s)' }
        ];
        const EVENT_TYPES_BY_KEY = {};
        EVENT_TYPES.forEach((entry) => { EVENT_TYPES_BY_KEY[entry.eventType] = entry; });

        const SUBSCRIPTION_STATUSES = { ACTIVE: 'Active', INACTIVE: 'Inactive' };

        const RESULT_RECORD = {
            TYPE: 'customrecord_wal_notif_subs',
            FIELDS: {
                ACTION: 'custrecord_wal_notif_sub_action',
                EVENT_TYPE: 'custrecord_wal_notif_sub_event_type',
                EVENT_VERSION: 'custrecord_wal_notif_sub_event_version',
                RESOURCE_NAME: 'custrecord_wal_notif_sub_resource_name',
                EVENT_URL: 'custrecord_wal_notif_sub_event_url',
                SUBSCRIPTION_STATUS: 'custrecord_wal_notif_sub_status',
                SUBSCRIPTION_ID: 'custrecord_wal_notif_sub_subscription_id',
                PARTNER_ID: 'custrecord_wal_notif_sub_partner_id',
                RESULT_STATUS: 'custrecord_wal_notif_sub_result',
                ERROR: 'custrecord_wal_notif_sub_error',
                CORRELATION: 'custrecord_wal_notif_sub_correlation_id',
                DATE_CREATED: 'custrecord_wal_notif_sub_date_created'
            },
            STATUS: { SUCCESS: 'Success', ERROR: 'Error' }
        };

        /**
         * @param {Object} params
         * @param {string} [params.subscriptionId] - repopulates the form after an attempt
         * @param {string} [params.action] - 'lookup' or 'update'
         * @param {string} [params.eventType]
         * @param {string} [params.status]
         * @param {string} [params.eventUrl]
         * @param {string} [params.resultText]
         */
        function buildForm(params) {
            params = params || {};
            const form = serverWidget.createForm({ title: `Walmart Notification Subscription Lookup/Update (${getScriptParams().environment})` });

            const actionField = form.addField({ id: 'custpage_action', type: serverWidget.FieldType.SELECT, label: 'Action' });
            actionField.addSelectOption({ value: 'lookup', text: 'Look Up' });
            actionField.addSelectOption({ value: 'update', text: 'Update' });
            actionField.defaultValue = params.action || 'lookup';

            const subscriptionIdField = form.addField({
                id: 'custpage_subscription_id', type: serverWidget.FieldType.TEXT,
                label: 'Subscription ID (optional for Look Up -- blank lists every subscription; required for Update)'
            });
            if (params.subscriptionId) subscriptionIdField.defaultValue = params.subscriptionId;

            const eventTypeField = form.addField({
                id: 'custpage_event_type', type: serverWidget.FieldType.SELECT,
                label: 'Event Type (Look Up: optional filter; Update: optional new value)'
            });
            eventTypeField.addSelectOption({ value: '', text: '-- Any / No Change --', isSelected: !params.eventType });
            EVENT_TYPES.forEach((entry) => {
                eventTypeField.addSelectOption({
                    value: entry.eventType,
                    text: `${entry.eventType} (${entry.resourceName})`,
                    isSelected: entry.eventType === params.eventType
                });
            });

            const statusField = form.addField({
                id: 'custpage_status', type: serverWidget.FieldType.SELECT,
                label: 'Status (Look Up: optional filter; Update: optional new value)'
            });
            statusField.addSelectOption({ value: '', text: '-- Any / No Change --', isSelected: !params.status });
            Object.keys(SUBSCRIPTION_STATUSES).forEach((key) => statusField.addSelectOption({
                value: key, text: SUBSCRIPTION_STATUSES[key], isSelected: key === params.status
            }));

            const eventUrlField = form.addField({
                id: 'custpage_event_url', type: serverWidget.FieldType.TEXT,
                label: 'Event URL (Update only -- new value; leave blank to leave unchanged)'
            });
            if (params.eventUrl) eventUrlField.defaultValue = params.eventUrl;

            form.addSubmitButton({ label: 'Submit' });

            if (params.resultText) {
                const resultField = form.addField({ id: 'custpage_result', type: serverWidget.FieldType.LONGTEXT, label: 'Result' });
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

            const p = context.request.parameters;
            const action = p.custpage_action || 'lookup';
            const doUpdate = action === 'update';
            const subscriptionId = (p.custpage_subscription_id || '').trim();
            const eventTypeKey = p.custpage_event_type || '';
            const status = p.custpage_status || '';
            const eventUrl = (p.custpage_event_url || '').trim();

            if (eventTypeKey && !EVENT_TYPES_BY_KEY[eventTypeKey]) {
                context.response.writePage(buildForm({ action, subscriptionId, eventType: eventTypeKey, status, eventUrl, resultText: 'Unrecognized Event Type.' }));
                return;
            }

            if (doUpdate && !subscriptionId) {
                context.response.writePage(buildForm({ action, subscriptionId, eventType: eventTypeKey, status, eventUrl, resultText: 'Subscription ID is required for Update.' }));
                return;
            }

            let patchBody;
            if (doUpdate) {
                patchBody = {};
                if (eventTypeKey) {
                    const entry = EVENT_TYPES_BY_KEY[eventTypeKey];
                    patchBody.eventType = entry.eventType;
                    patchBody.eventVersion = entry.eventVersion;
                    patchBody.resourceName = entry.resourceName;
                }
                if (eventUrl) patchBody.eventUrl = eventUrl;
                if (status) patchBody.status = status;

                if (!Object.keys(patchBody).length) {
                    context.response.writePage(buildForm({
                        action, subscriptionId, eventType: eventTypeKey, status, eventUrl,
                        resultText: 'Provide at least one of Event Type, Event URL, or Status to update.'
                    }));
                    return;
                }
            }

            const ctx = getScriptParams();
            if (!ctx.clientId || !ctx.clientSecret) {
                context.response.writePage(buildForm({
                    action, subscriptionId, eventType: eventTypeKey, status, eventUrl,
                    resultText: `Missing ${PARAMS.CLIENT_ID} / ${PARAMS.CLIENT_SECRET} script parameters.`
                }));
                return;
            }

            const baseUrl = BASE_URLS[ctx.environment] || BASE_URLS.SANDBOX;
            let resultText;
            let correlationId = random.generateUUID();

            try {
                const accessToken = getWalmartAccessToken({ clientId: ctx.clientId, clientSecret: ctx.clientSecret, baseUrl, correlationId });

                if (doUpdate) {
                    correlationId = random.generateUUID();
                    const before = getCurrentSubscription({ accessToken, baseUrl, subscriptionId, correlationId, environment: ctx.environment });
                    const beforeText = before ? JSON.stringify(before, null, 2) : '(could not be determined -- see execution log)';

                    correlationId = random.generateUUID();
                    const response = updateSubscription({ accessToken, baseUrl, correlationId, environment: ctx.environment, subscriptionId, patchBody });
                    const parsed = safeJsonParse(response.body, correlationId, 'update subscription');
            
                    const updatedList = Array.isArray(parsed) ? parsed : (parsed.event || parsed.events || []);
                    const updated = updatedList[0];

                    resultText = `Before:\n${beforeText}\n\n`
                        + `Requested changes:\n${JSON.stringify(patchBody, null, 2)}\n\n`
                        + `Walmart response:\n${response.body}`;

                    recordSubscriptionResult({ subscriptionId, patchBody, updated, status: RESULT_RECORD.STATUS.SUCCESS, correlationId });
                } else {
                    correlationId = random.generateUUID();
                    const response = getSubscriptions({ accessToken, baseUrl, correlationId, environment: ctx.environment, subscriptionId, eventType: eventTypeKey, status });
                    const parsed = safeJsonParse(response.body, correlationId, 'look up subscriptions');
                    // Sandbox's stub returns a bare array, not the documented {events: [...]}
                    // envelope -- handle both shapes rather than assuming the doc'd one always holds.
                    const events = Array.isArray(parsed) ? parsed : (parsed.events || []);
                    resultText = `Found ${events.length} subscription(s):\n${JSON.stringify(events, null, 2)}`;
                }

                resultText += `\n\ncorrelationId: ${correlationId} (reference this if you need to ask Walmart support about this request)`;
            } catch (e) {
                resultText = `Error: ${e.message}\n\ncorrelationId: ${correlationId}\n\nSee execution log for full request/response details.`;
                log.error({ title: `Notification subscription ${doUpdate ? 'update' : 'lookup'} failed (subscriptionId=${subscriptionId}, correlationId=${correlationId})`, details: e });

                if (doUpdate) {
                    recordSubscriptionResult({ subscriptionId, patchBody, status: RESULT_RECORD.STATUS.ERROR, errorMessage: e && e.message, correlationId });
                }
            }

            context.response.writePage(buildForm({ action, subscriptionId, eventType: eventTypeKey, status, eventUrl, resultText }));
        };

        /** GET /v3/webhooks/subscriptions -- subscriptionId/eventType/status are all optional filters; omitting every one lists everything. */
        function getSubscriptions(params) {
            const { accessToken, baseUrl, correlationId, environment, subscriptionId, eventType, status } = params;

            const query = [];
            if (subscriptionId) query.push(`subscriptionId=${encodeURIComponent(subscriptionId)}`);
            if (eventType) query.push(`eventType=${encodeURIComponent(eventType)}`);
            if (status) query.push(`status=${encodeURIComponent(status)}`);

            const response = https.get({
                url: `${baseUrl}/v3/webhooks/subscriptions${query.length ? '?' + query.join('&') : ''}`,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'WM_QOS.CORRELATION_ID': correlationId,
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'Accept': 'application/json'
                }
            });

            logHttpResponse('Walmart get subscriptions request', response, correlationId);
            if (response.code < 200 || response.code >= 300) {
                throw new Error(`Walmart get subscriptions request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }
            return response;
        }

        /**
         * Best-effort "before" snapshot for one subscription, shown alongside the update
         * result. Never throws -- a failed/blank lookup just leaves the before-state blank.
         */
        function getCurrentSubscription(params) {
            const { accessToken, baseUrl, subscriptionId, correlationId, environment } = params;
            try {
                const response = getSubscriptions({ accessToken, baseUrl, correlationId, environment, subscriptionId });
                const parsed = safeJsonParse(response.body, correlationId, 'get subscriptions (before-update snapshot)');
                // Same bare-array sandbox shape as getSubscriptions()'s own caller.
                const events = Array.isArray(parsed) ? parsed : (parsed.events || []);
                return events[0] || null;
            } catch (e) {
                log.error({ title: `Before-update snapshot failed (subscriptionId=${subscriptionId}, correlationId=${correlationId})`, details: e });
                return null;
            }
        }

        /** PATCH /v3/webhooks/subscriptions/{subscriptionId} -- only fields present in patchBody are sent, so unset fields keep their current Walmart value. */
        function updateSubscription(params) {
            const { accessToken, baseUrl, correlationId, environment, subscriptionId, patchBody } = params;

            const response = https.request({
                method: https.Method.PATCH,
                url: `${baseUrl}/v3/webhooks/subscriptions/${encodeURIComponent(subscriptionId)}`,
                body: JSON.stringify(patchBody),
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'WM_QOS.CORRELATION_ID': correlationId,
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            });

            logHttpResponse('Walmart update subscription request', response, correlationId);
            if (response.code < 200 || response.code >= 300) {
                throw new Error(`Walmart update subscription request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }
            return response;
        }

        function getWalmartAccessToken(params) {
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

        function getScriptParams() {
            const script = runtime.getCurrentScript();
            return {
                clientId: script.getParameter({ name: PARAMS.CLIENT_ID }),
                clientSecret: script.getParameter({ name: PARAMS.CLIENT_SECRET }),
                environment: (script.getParameter({ name: PARAMS.ENVIRONMENT }) || 'SANDBOX').toUpperCase()
            };
        }

        /** Only called on Update -- a pure Look Up never writes a tracking record. */
        function recordSubscriptionResult(params) {
            const { subscriptionId, patchBody, updated, status, errorMessage, correlationId } = params;
            try {
                const rec = record.create({ type: RESULT_RECORD.TYPE, isDynamic: false });
                rec.setValue({ fieldId: RESULT_RECORD.FIELDS.ACTION, value: 'Update' });
                rec.setValue({ fieldId: RESULT_RECORD.FIELDS.SUBSCRIPTION_ID, value: subscriptionId });
                if (patchBody && patchBody.eventType) rec.setValue({ fieldId: RESULT_RECORD.FIELDS.EVENT_TYPE, value: patchBody.eventType });
                if (patchBody && patchBody.eventVersion) rec.setValue({ fieldId: RESULT_RECORD.FIELDS.EVENT_VERSION, value: patchBody.eventVersion });
                if (patchBody && patchBody.resourceName) rec.setValue({ fieldId: RESULT_RECORD.FIELDS.RESOURCE_NAME, value: patchBody.resourceName });
                if (patchBody && patchBody.eventUrl) rec.setValue({ fieldId: RESULT_RECORD.FIELDS.EVENT_URL, value: patchBody.eventUrl });
                if (patchBody && patchBody.status) rec.setValue({ fieldId: RESULT_RECORD.FIELDS.SUBSCRIPTION_STATUS, value: patchBody.status });
                rec.setValue({ fieldId: RESULT_RECORD.FIELDS.RESULT_STATUS, value: status });
                rec.setValue({ fieldId: RESULT_RECORD.FIELDS.DATE_CREATED, value: new Date() });
                if (correlationId) rec.setValue({ fieldId: RESULT_RECORD.FIELDS.CORRELATION, value: correlationId });
                if (errorMessage) rec.setValue({ fieldId: RESULT_RECORD.FIELDS.ERROR, value: String(errorMessage).substring(0, 1000) });
                if (updated && updated.partnerId) rec.setValue({ fieldId: RESULT_RECORD.FIELDS.PARTNER_ID, value: updated.partnerId });

                return rec.save({ enableSourcing: false, ignoreMandatoryFields: true });
            } catch (recordError) {
                log.error('Failed to write notification subscription log record', {
                    subscriptionId, errorMessage: recordError && recordError.message
                });
                return null;
            }
        }

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

        function logHttpResponse(title, response, correlationId) {
            log[response.code >= 200 && response.code < 300 ? 'audit' : 'error']({
                title: `${title} (correlationId=${correlationId})`,
                details: JSON.stringify({ code: response.code, headers: response.headers, body: response.body })
            });
        }

        return { onRequest };
    }
);
