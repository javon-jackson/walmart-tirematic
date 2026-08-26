/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * Ops tool for mapping one or more SKUs to an already-created Walmart Shipping
 * Template -- POST /v3/feeds?feedType=SKU_TEMPLATE_MAP (multipart/form-data). 
 *
 * Script parameters:
 *   custscript_wal_shiptmpl_map_client_id  - Walmart Marketplace API Client ID
 *   custscript_wal_shiptmpl_map_secret     - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_shiptmpl_map_env        - "PRODUCTION" or "SANDBOX"
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
            CLIENT_ID: 'custscript_wal_shiptmpl_map_client_id',
            CLIENT_SECRET: 'custscript_wal_shiptmpl_map_secret',
            ENVIRONMENT: 'custscript_wal_shiptmpl_map_env'
        };

        const FEED_TYPE = 'SKU_TEMPLATE_MAP';
        
        const ACTION_TYPE_ADD = 'Add';

        const FEED_RECORD = {
            TYPE: 'customrecord_wal_feed_submission',
            FIELDS: {
                FEED_ID: 'custrecord_wal_feed_id',
                STATUS: 'custrecord_wal_feed_status',
                ENVIRONMENT: 'custrecord_wal_feed_env',
                ITEM_COUNT: 'custrecord_wal_feed_item_count',
                SUBMITTED_DATE: 'custrecord_wal_feed_submitted_date',
                DETAILS: 'custrecord_wal_feed_details',
                CORRELATION_ID: 'custrecord_wal_feed_correlation_id',
                FEED_TYPE: 'custrecord_wal_feed_type',
                SKUS: 'custrecord_wal_feed_skus'
            }
        };

        const FEED_STATUS = {
            RECEIVED: 'RECEIVED',
            ERROR: 'ERROR',
            RATE_LIMITED: 'RATE_LIMITED'
        };

        function onRequest(context) {
            const request = context.request;

            try {
                if (request.method !== 'POST') {
                    context.response.writePage(buildForm());
                    return;
                }
                handleSubmit(context);
            } catch (e) {
                log.error('Map SKUs to shipping template - unhandled error', {
                    errorName: e && e.name, errorMessage: e && e.message
                });
                context.response.writePage(buildResultPage({ success: false, message: e && e.message, correlationId: null }));
            }
        }

        function buildForm(errorMessage) {
            const form = serverWidget.createForm({ title: 'Map SKUs to Walmart Shipping Template' });
            if (errorMessage) {
                form.addPageInitMessage({ type: message.Type.ERROR, title: 'Error', message: errorMessage });
            }
            const group = addSingleColumnGroup(form, 'custpage_map_group');

            const templateIdField = form.addField({
                id: 'custpage_shipping_template_id', type: serverWidget.FieldType.TEXT,
                label: 'Shipping Template ID', container: group
            });
            templateIdField.isMandatory = true;

            const fcIdField = form.addField({
                id: 'custpage_fulfillment_center_id', type: serverWidget.FieldType.TEXT,
                label: 'Fulfillment Center ID', container: group
            });
            fcIdField.isMandatory = true;

            const skusField = form.addField({
                id: 'custpage_skus', type: serverWidget.FieldType.LONGTEXT,
                label: 'SKUs (one per line, or comma-separated)', container: group
            });
            skusField.isMandatory = true;

            const noteField = form.addField({ id: 'custpage_note', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
            noteField.defaultValue = '<p style="font-size:12px;color:#666;">'
                + `Every SKU entered will be mapped to the same Shipping Template and Fulfillment Center in one feed submission. `
                + 'Duplicate SKUs are removed automatically.</p>';

            form.addSubmitButton({ label: 'Submit Mapping to Walmart' });
            return form;
        }

        function handleSubmit(context) {
            const p = context.request.parameters;
            const shippingTemplateId = (p.custpage_shipping_template_id || '').trim();
            const fulfillmentCenterId = (p.custpage_fulfillment_center_id || '').trim();
            // Split on newline or comma, trim, drop blanks, de-dupe -- same de-dupe convention
            // as wm_mr_price_feed_upload.js's reduce().
            const skus = Array.from(new Set(
                (p.custpage_skus || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
            ));

            if (!shippingTemplateId || !fulfillmentCenterId || !skus.length) {
                context.response.writePage(buildForm('Shipping Template ID, Fulfillment Center ID, and at least one SKU are required.'));
                return;
            }

            const ctx = getScriptParams();
            const baseUrl = BASE_URLS[ctx.environment] || BASE_URLS.SANDBOX;
            const correlationId = random.generateUUID();

            try {
                const accessToken = getWalmartAccessToken({ clientId: ctx.clientId, clientSecret: ctx.clientSecret, baseUrl, correlationId });
                const payload = buildFeedPayload({ skus, shippingTemplateId, fulfillmentCenterId });
                const feedId = submitSkuTemplateMapFeed({ accessToken, baseUrl, correlationId, payload });

                recordFeedSubmission({
                    feedId, status: FEED_STATUS.RECEIVED, environment: ctx.environment,
                    itemCount: skus.length, correlationId, skus
                });

                context.response.writePage(buildResultPage({
                    success: true,
                    message: `Submitted ${skus.length} SKU(s) for mapping to shipping template "${shippingTemplateId}" (feedId: ${feedId}). `
                        + 'Check wm_sl_feed_status.js in a few minutes for the processing result.',
                    correlationId,
                    skus
                }));
            } catch (e) {
                log.error('Failed to submit SKU_TEMPLATE_MAP feed', {
                    shippingTemplateId, fulfillmentCenterId, errorName: e && e.name, errorMessage: e && e.message
                });
                const status = e.responseCode === 429 ? FEED_STATUS.RATE_LIMITED : FEED_STATUS.ERROR;
                recordFeedSubmission({
                    status, environment: ctx.environment, itemCount: skus.length,
                    correlationId, skus, errorMessage: e && e.message
                });
                context.response.writePage(buildResultPage({ success: false, message: e && e.message, correlationId }));
            }
        }

        function buildFeedPayload(params) {
            const { skus, shippingTemplateId, fulfillmentCenterId } = params;
            return {
                Item: skus.map((sku) => ({
                    PreciseDelivery: { shippingTemplateId, fulfillmentCenterId, actionType: ACTION_TYPE_ADD, sku }
                })),
                ItemFeedHeader: { sellingChannel: 'precisedelivery', locale: 'en', version: '1.0' }
            };
        }

        function submitSkuTemplateMapFeed(params) {
            const { accessToken, baseUrl, correlationId, payload } = params;

            const boundary = `----WalmartSkuTemplateMapBoundary${random.generateUUID().replace(/-/g, '')}`;
            const body = buildMultipartBody(boundary, JSON.stringify(payload), 'sku-template-map-feed.json');

            const response = https.post({
                url: `${baseUrl}/v3/feeds?feedType=${FEED_TYPE}`,
                body,
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_QOS.CORRELATION_ID': correlationId,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'Accept': 'application/json',
                    'Content-Type': `multipart/form-data; boundary=${boundary}`
                }
            });

            logHttpResponse('Walmart SKU_TEMPLATE_MAP feed submission', response, correlationId);
            if (response.code !== 200) {
                const error = new Error(`Walmart SKU_TEMPLATE_MAP feed submission failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
                error.responseCode = response.code;
                throw error;
            }

            const parsed = safeJsonParse(response.body, correlationId, 'SKU_TEMPLATE_MAP feed submission');
            if (!parsed.feedId) {
                throw new Error(`Walmart SKU_TEMPLATE_MAP feed response missing feedId (correlationId=${correlationId}): ${response.body}`);
            }
            return parsed.feedId;
        }

        /** Same hand-rolled multipart builder as wm_mr_tire_upload.js -- N/https has no native multipart support. */
        function buildMultipartBody(boundary, fileContent, filename) {
            const CRLF = '\r\n';
            return `--${boundary}${CRLF}`
                + `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}`
                + `Content-Type: application/json${CRLF}${CRLF}`
                + `${fileContent}${CRLF}`
                + `--${boundary}--${CRLF}`;
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

        function recordFeedSubmission(params) {
            const { feedId, status, environment, itemCount, correlationId, skus, errorMessage } = params;
            try {
                const rec = record.create({ type: FEED_RECORD.TYPE, isDynamic: false });
                if (feedId) rec.setValue({ fieldId: FEED_RECORD.FIELDS.FEED_ID, value: feedId });
                rec.setValue({ fieldId: FEED_RECORD.FIELDS.STATUS, value: status });
                rec.setValue({ fieldId: FEED_RECORD.FIELDS.ENVIRONMENT, value: environment });
                rec.setValue({ fieldId: FEED_RECORD.FIELDS.ITEM_COUNT, value: itemCount });
                rec.setValue({ fieldId: FEED_RECORD.FIELDS.SUBMITTED_DATE, value: new Date() });
                rec.setValue({ fieldId: FEED_RECORD.FIELDS.CORRELATION_ID, value: correlationId });
                rec.setValue({ fieldId: FEED_RECORD.FIELDS.FEED_TYPE, value: FEED_TYPE });
                if (skus) rec.setValue({ fieldId: FEED_RECORD.FIELDS.SKUS, value: JSON.stringify(skus).substring(0, 100000) });
                if (errorMessage) rec.setValue({ fieldId: FEED_RECORD.FIELDS.DETAILS, value: String(errorMessage).substring(0, 1000) });
                return rec.save({ enableSourcing: false, ignoreMandatoryFields: true });
            } catch (recordError) {
                log.error('Failed to write feed submission tracking record', {
                    feedId, errorMessage: recordError && recordError.message
                });
                return null;
            }
        }

        function buildResultPage(params) {
            const { success, message, correlationId, skus } = params;
            const form = serverWidget.createForm({ title: success ? 'Mapping Submitted' : 'Mapping Failed' });
            const text = [
                success ? 'Success.' : 'Error.',
                message,
                skus ? `\n\nSKUs: ${skus.join(', ')}` : '',
                correlationId ? `\n\ncorrelationId: ${correlationId} (reference this if you need to ask Walmart support about this submission)` : ''
            ].filter(Boolean).join(' ');

            const resultField = form.addField({ id: 'custpage_result', type: serverWidget.FieldType.LONGTEXT, label: 'Result' });
            resultField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
            resultField.defaultValue = text;

            const nextField = form.addField({ id: 'custpage_next', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
            nextField.defaultValue = '<div style="padding:10px 0;">'
                + `<a href="${buildSuiteletUrl()}" style="${BUTTON_STYLE}">Map more SKUs</a>`
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
