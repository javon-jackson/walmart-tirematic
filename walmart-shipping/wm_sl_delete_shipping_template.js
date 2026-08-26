/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * Ops tool for DELETING an existing Walmart "Shipping Template" through Walmart's
 * Delete Shipping Template Details API -- DELETE /v3/settings/shipping/templates/{templateId}.
 *
 * Flow:
 *   STEP 1 (ENTER TEMPLATE ID): the Walmart template to delete.
 *   STEP 2 (CONFIRM): explicit "this cannot be undone" confirmation screen with the
 *     Template ID carried forward as a hidden field. Submitting this is what actually
 *     calls Walmart's DELETE endpoint.
 *
 * Script parameters:
 *   custscript_wal_del_ship_tmpl_client_id  - Walmart Marketplace API Client ID
 *   custscript_wal_del_ship_tmpl_secret     - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_del_ship_tmpl_env        - "PRODUCTION" or "SANDBOX"
 *
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
        
        const DANGER_BUTTON_STYLE = 'background:#c0392b !important;color:#fff !important;'
            + 'font-weight:bold !important;border-color:#c0392b !important;';

        const PARAMS = {
            CLIENT_ID: 'custscript_wal_del_ship_tmpl_client_id',
            CLIENT_SECRET: 'custscript_wal_del_ship_tmpl_secret',
            ENVIRONMENT: 'custscript_wal_del_ship_tmpl_env'
        };

        const RESULT_RECORD = {
            TYPE: 'customrecord_wal_shipping_templates',
            FIELDS: {
                NAME: 'custrecord_wal_shiptmpl_name',
                TEMPLATE_ID: 'custrecord_wal_shiptmpl_id',
                STATUS: 'custrecord_wal_shiptmpl_status', // this script's OWN Confirmed/Error outcome
                RESPONSE: 'custrecord_wal_shiptmpl_response',
                ERROR: 'custrecord_wal_shiptmpl_error',
                CORRELATION: 'custrecord_wal_shiptmpl_correlation_id',
                DATE_CREATED: 'custrecord_wal_shiptmpl_date_created'
            },
            STATUS: { SUCCESS: 'Success', ERROR: 'Error' }
        };

        const ACTION = {
            CONFIRM: 'confirm',
            DELETE_TEMPLATE: 'deleteTemplate'
        };

        function onRequest(context) {
            const request = context.request;
            const action = request.parameters.custpage_action;

            try {
                if (request.method !== 'POST') {
                    context.response.writePage(buildEnterIdForm());
                    return;
                }

                if (action === ACTION.CONFIRM) {
                    handleConfirm(context);
                } else if (action === ACTION.DELETE_TEMPLATE) {
                    handleDeleteTemplate(context);
                } else {
                    context.response.writePage(buildEnterIdForm('Unknown action -- please start again.'));
                }
            } catch (e) {
                log.error('Delete shipping template - unhandled error', {
                    action, errorName: e && e.name, errorMessage: e && e.message
                });
                context.response.writePage(buildResultPage({ success: false, message: e && e.message, correlationId: null }));
            }
        }

        /** STEP 1: just the Template ID to delete. */
        function buildEnterIdForm(errorMessage) {
            const form = serverWidget.createForm({ title: 'Delete Walmart Shipping Template' });
            if (errorMessage) {
                form.addPageInitMessage({ type: message.Type.ERROR, title: 'Error', message: errorMessage });
            }
            const group = addSingleColumnGroup(form, 'custpage_enter_id_group');

            const warningField = form.addField({ id: 'custpage_warning', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
            warningField.defaultValue = '<p style="color:#c0392b;"><strong>This permanently deletes the template from Walmart -- '
                + 'there is no undo.</strong> If the template is still assigned to items in Seller Center, deleting it may affect '
                + 'those items\' shipping configuration.</p>';

            const templateIdField = form.addField({ id: 'custpage_template_id', type: serverWidget.FieldType.TEXT, label: 'Walmart Template ID', container: group });
            templateIdField.isMandatory = true;

            form.addSubmitButton({ label: 'Next: Confirm' });
            const actionField = form.addField({ id: 'custpage_action', type: serverWidget.FieldType.TEXT, label: 'Action', container: group });
            actionField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            actionField.defaultValue = ACTION.CONFIRM;
            return form;
        }

        /** STEP 1 -> STEP 2: validate the Template ID was entered, render an explicit confirmation screen. */
        function handleConfirm(context) {
            const p = context.request.parameters;
            if (!p.custpage_template_id || !p.custpage_template_id.trim()) {
                context.response.writePage(buildEnterIdForm('Template ID is required.'));
                return;
            }
            context.response.writePage(buildConfirmForm(p.custpage_template_id.trim()));
        }

        /** STEP 2: explicit "this cannot be undone" confirmation -- submitting THIS is what calls Walmart's DELETE endpoint. */
        function buildConfirmForm(templateId) {
            const form = serverWidget.createForm({ title: `Confirm Delete -- Template ${templateId}` });
            const group = addSingleColumnGroup(form, 'custpage_confirm_group');

            const messageField = form.addField({ id: 'custpage_confirm_message', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
            messageField.defaultValue = `<p>You are about to permanently delete Walmart shipping template <strong>${escapeHtml(templateId)}</strong>. `
                + '<strong style="color:#c0392b;">This cannot be undone.</strong> Click "Delete Template" below only if you\'re sure.</p>';

            const templateIdField = form.addField({ id: 'custpage_template_id', type: serverWidget.FieldType.TEXT, label: 'Template ID', container: group });
            templateIdField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
            templateIdField.defaultValue = templateId;

            const templateIdHiddenField = form.addField({ id: 'custpage_template_id_hidden', type: serverWidget.FieldType.TEXT, label: 'Template ID', container: group });
            templateIdHiddenField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            templateIdHiddenField.defaultValue = templateId;

            form.addSubmitButton({ label: 'Delete Template' });
            const actionField = form.addField({ id: 'custpage_action', type: serverWidget.FieldType.TEXT, label: 'Action', container: group });
            actionField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            actionField.defaultValue = ACTION.DELETE_TEMPLATE;

            // Restyles the native submit button
            const buttonStyleField = form.addField({ id: 'custpage_delete_button_style', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
            buttonStyleField.defaultValue = `<style>input[type="submit"][value="Delete Template"]{${DANGER_BUTTON_STYLE}}</style>`;

            const cancelField = form.addField({ id: 'custpage_cancel', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
            cancelField.defaultValue = '<div style="padding:10px 0;">'
                + `<a href="${buildSuiteletUrl()}" style="color:#666;font-size:13px;text-decoration:underline;">Cancel this action</a>`
                + '</div>';

            return form;
        }

        /** STEP 2 submit: the actual DELETE call to Walmart. */
        function handleDeleteTemplate(context) {
            const p = context.request.parameters;
            const templateId = (p.custpage_template_id_hidden || p.custpage_template_id || '').trim();
            if (!templateId) {
                context.response.writePage(buildResultPage({ success: false, message: 'Missing Template ID -- please start again.' }));
                return;
            }

            const ctx = getScriptParams();
            const baseUrl = BASE_URLS[ctx.environment] || BASE_URLS.SANDBOX;
            const correlationId = random.generateUUID();

            try {
                const accessToken = getWalmartAccessToken({ clientId: ctx.clientId, clientSecret: ctx.clientSecret, baseUrl, correlationId });
                const response = deleteShippingTemplate({ accessToken, baseUrl, correlationId, environment: ctx.environment, templateId });

                recordTemplateResult({
                    templateId, status: RESULT_RECORD.STATUS.SUCCESS,
                    responseBody: response.body, correlationId
                });

                context.response.writePage(buildResultPage({
                    success: true,
                    message: `Shipping template ${templateId} deleted from Walmart (${response.code}).`,
                    correlationId,
                    responseBody: response.body
                }));
            } catch (e) {
                log.error('Failed to delete Walmart shipping template', {
                    templateId, errorName: e && e.name, errorMessage: e && e.message
                });
                recordTemplateResult({
                    templateId, status: RESULT_RECORD.STATUS.ERROR,
                    errorMessage: e && e.message, correlationId
                });
                context.response.writePage(buildResultPage({ success: false, message: e && e.message, correlationId }));
            }
        }

        function deleteShippingTemplate(params) {
            const { accessToken, baseUrl, correlationId, environment, templateId } = params;

            const response = https.delete({
                url: `${baseUrl}/v3/settings/shipping/templates/${encodeURIComponent(templateId)}`,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'WM_QOS.CORRELATION_ID': correlationId,
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'Accept': 'application/json'
                }
            });

            logHttpResponse('Walmart delete shipping template request', response, correlationId);
            if (response.code < 200 || response.code >= 300) {
                throw new Error(`Walmart delete shipping template request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
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

        /** Best-effort audit trail -- reuses the same record type the create/update Suitelets write to (see file header). */
        function recordTemplateResult(params) {
            const { templateId, status, responseBody, errorMessage, correlationId } = params;
            try {
                const rec = record.create({ type: RESULT_RECORD.TYPE, isDynamic: false });
                rec.setValue({ fieldId: RESULT_RECORD.FIELDS.STATUS, value: status });
                rec.setValue({ fieldId: RESULT_RECORD.FIELDS.DATE_CREATED, value: new Date() });
                if (templateId) rec.setValue({ fieldId: RESULT_RECORD.FIELDS.TEMPLATE_ID, value: templateId });
                if (correlationId) rec.setValue({ fieldId: RESULT_RECORD.FIELDS.CORRELATION, value: correlationId });
                if (responseBody) rec.setValue({ fieldId: RESULT_RECORD.FIELDS.RESPONSE, value: String(responseBody).substring(0, 100000) });
                if (errorMessage) rec.setValue({ fieldId: RESULT_RECORD.FIELDS.ERROR, value: String(errorMessage).substring(0, 1000) });

                return rec.save({ enableSourcing: false, ignoreMandatoryFields: true });
            } catch (recordError) {
                log.error('Failed to write shipping template log record', {
                    templateId, errorMessage: recordError && recordError.message
                });
                return null;
            }
        }

        function buildResultPage(params) {
            const { success, message, correlationId, responseBody } = params;
            const form = serverWidget.createForm({ title: success ? 'Shipping Template Deleted' : 'Shipping Template Delete Failed' });
            const text = [
                success ? 'Success.' : 'Error.',
                message,
                correlationId ? `\n\ncorrelationId: ${correlationId} (reference this if you need to ask Walmart support about this template)` : '',
                responseBody ? `\n\nWalmart response:\n${responseBody}` : ''
            ].filter(Boolean).join(' ');

            const resultField = form.addField({ id: 'custpage_result', type: serverWidget.FieldType.LONGTEXT, label: 'Result' });
            resultField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
            resultField.defaultValue = text;

            const nextField = form.addField({ id: 'custpage_next', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
            nextField.defaultValue = '<div style="padding:10px 0;">'
                + `<a href="${buildSuiteletUrl()}" style="${BUTTON_STYLE}">Delete another template</a>`
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

        function escapeHtml(str) {
            return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
