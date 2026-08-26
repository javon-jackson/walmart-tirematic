/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * Ops tool for subscribing to a Walmart Marketplace notification (webhook) event
 * through Walmart's Create Subscription API -- POST /v3/webhooks/subscriptions.
 * One event subscription per submit.
 *
 * Script parameters:
 *   custscript_wal_notif_sub_client_id  - Walmart Marketplace API Client ID
 *   custscript_wal_notif_sub_secret     - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_notif_sub_env        - "PRODUCTION" or "SANDBOX"
 */
define(
    ['N/record', 'N/runtime', 'N/https', 'N/encode', 'N/log', 'N/crypto/random', 'N/ui/serverWidget', 'N/ui/message', 'N/url'],
    (record, runtime, https, encode, log, random, serverWidget, message, url) => {

        const BASE_URLS = {
            PRODUCTION: 'https://marketplace.walmartapis.com',
            SANDBOX: 'https://sandbox.walmartapis.com'
        };

        const BUTTON_STYLE = 'display:inline-block;padding:10px 20px;background:#187bf2;color:#fff;'
            + 'font-weight:bold;font-size:14px;text-decoration:none;border-radius:3px;border:none;cursor:pointer;';

        const PARAMS = {
            CLIENT_ID: 'custscript_wal_notif_sub_client_id',
            CLIENT_SECRET: 'custscript_wal_notif_sub_secret',
            ENVIRONMENT: 'custscript_wal_notif_sub_env'
        };

        const SUBSCRIPTION_STATUSES = { ACTIVE: 'Active', INACTIVE: 'Inactive' };

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

        const RESULT_RECORD = {
            TYPE: 'customrecord_wal_notif_subs',
            FIELDS: {
                ACTION: 'custrecord_wal_notif_sub_action',                     // CREATE/DELETE -- which tool wrote this row
                EVENT_TYPE: 'custrecord_wal_notif_sub_event_type',
                EVENT_VERSION: 'custrecord_wal_notif_sub_event_version',
                RESOURCE_NAME: 'custrecord_wal_notif_sub_resource_name',
                EVENT_URL: 'custrecord_wal_notif_sub_event_url',
                SUBSCRIPTION_STATUS: 'custrecord_wal_notif_sub_status',         // ACTIVE/INACTIVE
                SUBSCRIPTION_ID: 'custrecord_wal_notif_sub_subscription_id',    // Walmart's returned id
                PARTNER_ID: 'custrecord_wal_notif_sub_partner_id',
                RESULT_STATUS: 'custrecord_wal_notif_sub_result',               // this script's OWN Success/Error outcome
                ERROR: 'custrecord_wal_notif_sub_error',
                CORRELATION: 'custrecord_wal_notif_sub_correlation_id',
                DATE_CREATED: 'custrecord_wal_notif_sub_date_created'
            },
            STATUS: { SUCCESS: 'Success', ERROR: 'Error' }
        };

        function onRequest(context) {
            try {
                if (context.request.method !== 'POST') {
                    context.response.writePage(buildForm());
                    return;
                }
                handleCreateSubscription(context);
            } catch (e) {
                log.error('Notification subscription - unhandled error', {
                    errorName: e && e.name, errorMessage: e && e.message
                });
                context.response.writePage(buildResultPage({ success: false, message: e && e.message, correlationId: null }));
            }
        }

        function buildForm(errorMessage, p) {
            p = p || {};
            const form = serverWidget.createForm({ title: 'Subscribe to Walmart Notification' });
            if (errorMessage) {
                form.addPageInitMessage({ type: message.Type.ERROR, title: 'Error', message: errorMessage });
            }
            const group = addSingleColumnGroup(form, 'custpage_group');

            const instructionsField = form.addField({ id: 'custpage_instructions', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
            instructionsField.defaultValue = '<p>Creates ONE event subscription via Walmart\'s Create Subscription API '
                + '(<code>POST /v3/webhooks/subscriptions</code>). Submit again to subscribe to another event.</p>';

            const eventTypeField = form.addField({ id: 'custpage_event_type', type: serverWidget.FieldType.SELECT, label: 'Event Type', container: group });
            const selectedEventType = p.custpage_event_type || 'PO_CREATED';
            EVENT_TYPES.forEach((entry) => {
                eventTypeField.addSelectOption({
                    value: entry.eventType,
                    text: `${entry.eventType} (${entry.resourceName}) -- ${entry.description}`,
                    isSelected: entry.eventType === selectedEventType
                });
            });

            const eventUrlField = form.addField({ id: 'custpage_event_url', type: serverWidget.FieldType.TEXT, label: 'Event URL', container: group });
            eventUrlField.isMandatory = true;
            eventUrlField.defaultValue = p.custpage_event_url || '';

            const statusField = form.addField({ id: 'custpage_status', type: serverWidget.FieldType.SELECT, label: 'Subscription Status', container: group });
            Object.keys(SUBSCRIPTION_STATUSES).forEach((key) => statusField.addSelectOption({ value: key, text: SUBSCRIPTION_STATUSES[key], isSelected: key === (p.custpage_status || 'ACTIVE') }));

            form.addSubmitButton({ label: 'Create Subscription' });
            return form;
        }

        function handleCreateSubscription(context) {
            const p = context.request.parameters;

            if (!p.custpage_event_type || !EVENT_TYPES_BY_KEY[p.custpage_event_type] || !p.custpage_event_url) {
                context.response.writePage(buildForm('Event Type and Event URL are required.', p));
                return;
            }

            const event = buildEventPayload(p);
            const ctx = getScriptParams();
            const baseUrl = BASE_URLS[ctx.environment] || BASE_URLS.SANDBOX;
            const correlationId = random.generateUUID();

            try {
                const accessToken = getWalmartAccessToken({ clientId: ctx.clientId, clientSecret: ctx.clientSecret, baseUrl, correlationId });
                const response = submitSubscription({ accessToken, baseUrl, correlationId, environment: ctx.environment, event });
                const parsed = safeJsonParse(response.body, correlationId, 'create subscription');
                const created = parsed.events && parsed.events[0];

                recordSubscriptionResult({
                    event, created, status: RESULT_RECORD.STATUS.SUCCESS,
                    correlationId
                });

                context.response.writePage(buildResultPage({
                    success: true,
                    message: `Subscribed to "${event.eventType}" (${event.resourceName}) at ${event.eventUrl} (${response.code}).`
                        + (created && created.subscriptionId ? ` subscriptionId=${created.subscriptionId}` : ''),
                    correlationId,
                    responseBody: response.body
                }));
            } catch (e) {
                log.error('Failed to create Walmart notification subscription', {
                    eventType: event.eventType, errorName: e && e.name, errorMessage: e && e.message
                });
                recordSubscriptionResult({
                    event, status: RESULT_RECORD.STATUS.ERROR,
                    errorMessage: e && e.message, correlationId
                });
                context.response.writePage(buildResultPage({ success: false, message: e && e.message, correlationId }));
            }
        }

        /**
         * Builds ONE event entry.
         */
        function buildEventPayload(p) {
            const entry = EVENT_TYPES_BY_KEY[p.custpage_event_type];
            return {
                eventType: entry.eventType,
                eventVersion: entry.eventVersion,
                resourceName: entry.resourceName,
                eventUrl: p.custpage_event_url.trim(),
                status: p.custpage_status || 'ACTIVE'
            };
        }

        function submitSubscription(params) {
            const { accessToken, baseUrl, correlationId, environment, event } = params;

            const response = https.post({
                url: `${baseUrl}/v3/webhooks/subscriptions`,
                body: JSON.stringify({ events: [event] }),
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'WM_QOS.CORRELATION_ID': correlationId,
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            });

            logHttpResponse('Walmart create subscription request', response, correlationId);
            if (response.code < 200 || response.code >= 300) {
                throw new Error(`Walmart create subscription request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
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

        /** Best-effort audit trail -- fails soft (logged, not thrown) if the record type/fields aren't there. */
        function recordSubscriptionResult(params) {
            const { event, created, status, errorMessage, correlationId } = params;
            try {
                const rec = record.create({ type: RESULT_RECORD.TYPE, isDynamic: false });
                rec.setValue({ fieldId: RESULT_RECORD.FIELDS.ACTION, value: 'Create' });
                rec.setValue({ fieldId: RESULT_RECORD.FIELDS.EVENT_TYPE, value: event.eventType });
                rec.setValue({ fieldId: RESULT_RECORD.FIELDS.EVENT_VERSION, value: event.eventVersion });
                rec.setValue({ fieldId: RESULT_RECORD.FIELDS.RESOURCE_NAME, value: event.resourceName });
                rec.setValue({ fieldId: RESULT_RECORD.FIELDS.EVENT_URL, value: event.eventUrl });
                if (status === RESULT_RECORD.STATUS.SUCCESS) {
                    rec.setValue({ fieldId: RESULT_RECORD.FIELDS.SUBSCRIPTION_STATUS, value: event.status });
                }
                rec.setValue({ fieldId: RESULT_RECORD.FIELDS.RESULT_STATUS, value: status });
                rec.setValue({ fieldId: RESULT_RECORD.FIELDS.DATE_CREATED, value: new Date() });
                if (correlationId) rec.setValue({ fieldId: RESULT_RECORD.FIELDS.CORRELATION, value: correlationId });
                if (errorMessage) rec.setValue({ fieldId: RESULT_RECORD.FIELDS.ERROR, value: String(errorMessage).substring(0, 1000) });
                if (created && created.subscriptionId) rec.setValue({ fieldId: RESULT_RECORD.FIELDS.SUBSCRIPTION_ID, value: created.subscriptionId });
                if (created && created.partnerId) rec.setValue({ fieldId: RESULT_RECORD.FIELDS.PARTNER_ID, value: created.partnerId });

                return rec.save({ enableSourcing: false, ignoreMandatoryFields: true });
            } catch (recordError) {
                log.error('Failed to write notification subscription log record', {
                    eventType: event && event.eventType, errorMessage: recordError && recordError.message
                });
                return null;
            }
        }

        function buildResultPage(params) {
            const { success, message, correlationId, responseBody } = params;
            const form = serverWidget.createForm({ title: success ? 'Subscription Created' : 'Subscription Failed' });
            const text = [
                success ? 'Success.' : 'Error.',
                message,
                correlationId ? `\n\ncorrelationId: ${correlationId} (reference this if you need to ask Walmart support about this subscription)` : '',
                responseBody ? `\n\nWalmart response:\n${responseBody}` : ''
            ].filter(Boolean).join(' ');

            const resultField = form.addField({ id: 'custpage_result', type: serverWidget.FieldType.LONGTEXT, label: 'Result' });
            resultField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
            resultField.defaultValue = text;

            const nextField = form.addField({ id: 'custpage_next', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
            nextField.defaultValue = '<div style="padding:10px 0;">'
                + `<a href="${buildSuiteletUrl()}" style="${BUTTON_STYLE}">Create another subscription</a>`
                + '</div>';

            return form;
        }

        function buildSuiteletUrl() {
            const script = runtime.getCurrentScript();
            return url.resolveScript({ scriptId: script.id, deploymentId: script.deploymentId, returnExternalUrl: false });
        }

        function addSingleColumnGroup(form, id) {
            const group = form.addFieldGroup({ id, label: ' ' });
            group.isSingleColumn = true;
            return id;
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
