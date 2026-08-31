/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * Ops tool for UPDATING an existing Walmart Fulfillment Center (AKA ship node)
 *
 * FLOW:
 *   STEP 1 (SELECT): landing page fetches the full fulfillment center list
 *     and renders it as a dropdown. The full raw list is carried forward as a hidden JSON
 *     field so choosing one doesn't require a second Walmart call.
 *   STEP 2 (EDIT): displays edit field pre-filled with the current Fulfillment Center configuration.
 *   Submitting STEP 2 PUTs the full payload to
 *     /v3/settings/shipping/shipnodes.
 *
 *
 * Script parameters:
 *   custscript_wal_update_fc_client_id      - Walmart Marketplace API Client ID
 *   custscript_wal_update_fc_client_secret  - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_update_fc_env            - "PRODUCTION" or "SANDBOX"
 * 
 * 
 * TODO: sandbox requests require distributorSupportedServices = ['TWO_DAY_DELIVERY'] and something set in shippingDetails.twoDayShipping.
 *       This could be an error with the docs or a sandbox limitation.
 */
define(['N/runtime', 'N/https', 'N/encode', 'N/log', 'N/crypto/random', 'N/ui/serverWidget', 'N/ui/message', 'N/url'],
       (runtime, https, encode, log, random, serverWidget, message, url) =>
{
    const BASE_URLS = {
        PRODUCTION: 'https://marketplace.walmartapis.com',
        SANDBOX: 'https://sandbox.walmartapis.com'
    };

    const BUTTON_STYLE = 'display:inline-block;padding:10px 20px;background:#187bf2;color:#fff;'
        + 'font-weight:bold;font-size:14px;text-decoration:none;border-radius:3px;border:none;cursor:pointer;';

    const PARAMS = {
        CLIENT_ID: 'custscript_wal_update_fc_client_id',
        CLIENT_SECRET: 'custscript_wal_update_fc_client_secret',
        ENVIRONMENT: 'custscript_wal_update_fc_env'
    };

    const SHIP_NODE_HEADER_VERSION = '1.2';

    const STATUSES = { ACTIVE: 'Active', INACTIVE: 'Inactive' };

    const TIME_ZONES = [
        'PST', 'MST', 'CST', 'EST', 'PDT', 'MDT', 'CDT', 'EDT', 'ADT', 'NDT',
        'GMT', 'CET', 'TRT', 'IST', 'CTT', 'HKT', 'SGT', 'ICT', 'JST', 'KST', 'VST', 'CLT'
    ];
    const DAYS_OF_WEEK = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const DAY_LABELS = {
        sunday: 'Sunday', monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday',
        thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday'
    };
    const DEFAULT_CUTOFF_TIME = '14:00';
    const CUTOFF_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
    const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

    const CARRIER_METHOD_NAMES = ['UPS', 'USPS', 'Fedex'];
    const CARRIER_METHOD_TYPES = ['GROUND'];

    const ACTION = { SELECT: 'select', UPDATE: 'update' };

    function getScriptParams() {
        const script = runtime.getCurrentScript();
        return {
            clientId: script.getParameter({ name: PARAMS.CLIENT_ID }),
            clientSecret: script.getParameter({ name: PARAMS.CLIENT_SECRET }),
            environment: (script.getParameter({ name: PARAMS.ENVIRONMENT }) || 'SANDBOX').toUpperCase()
        };
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

    /**
     * GET /v3/settings/shipping/shipnodes -- returns EVERY fulfillment
     * center on the account as a top-level array.
     * There is no Walmart API to fetch a single fulfillment center by ID.
     * @returns {Array<Object>}
     */
    function getAllFulfillmentCenters(params) {
        const { accessToken, baseUrl, correlationId, environment } = params;

        const response = https.get({
            url: `${baseUrl}/v3/settings/shipping/shipnodes?includeCalendarDayConfiguration=true`,
            headers: {
                'WM_SEC.ACCESS_TOKEN': accessToken,
                'WM_QOS.CORRELATION_ID': correlationId,
                'WM_SVC.NAME': 'Walmart Marketplace',
                ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                'Accept': 'application/json'
            }
        });

        logHttpResponse('Walmart get all fulfillment centers request', response, correlationId);
        if (response.code < 200 || response.code >= 300) {
            throw new Error(`Walmart get all fulfillment centers request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
        }

        const parsed = safeJsonParse(response.body, correlationId, 'get all fulfillment centers');
        return Array.isArray(parsed) ? parsed : [];
    }

    function updateFulfillmentCenter(params) {
        const { accessToken, baseUrl, correlationId, environment, payload } = params;

        log.audit(`Walmart update fulfillment center request body (correlationId=${correlationId})`, JSON.stringify(payload));

        const response = https.put({
            url: `${baseUrl}/v3/settings/shipping/shipnodes`,
            body: JSON.stringify(payload),
            headers: {
                'WM_SEC.ACCESS_TOKEN': accessToken,
                'WM_QOS.CORRELATION_ID': correlationId,
                'WM_SVC.NAME': 'Walmart Marketplace',
                ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        });

        logHttpResponse('Walmart update fulfillment center request', response, correlationId);
        if (response.code < 200 || response.code >= 300) {
            throw new Error(`Walmart update fulfillment center request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
        }
        return response;
    }

    function onRequest(context) {
        try {
            if (context.request.method !== 'POST') {
                handleShowSelectForm(context);
                return;
            }

            const action = context.request.parameters.custpage_action;
            if (action === ACTION.SELECT) {
                handleSelect(context);
            } else if (action === ACTION.UPDATE) {
                handleUpdate(context);
            } else {
                handleShowSelectForm(context, 'Unknown action -- please start again.');
            }
        } catch (e) {
            log.error('Update fulfillment center - unhandled error', {
                errorName: e && e.name, errorMessage: e && e.message
            });
            context.response.writePage(buildResultPage({ success: false, message: e && e.message, correlationId: null }));
        }
    }

    /**
     * STEP 1: fetches the full fulfillment center list from Walmart and
     * renders it as a dropdown. On fetch failure, shows an error page with
     * a retry link instead of crashing -- this call happens on every plain
     * page load, so a transient Walmart/token failure shouldn't be fatal.
     */
    function handleShowSelectForm(context, errorMessage) {
        const ctx = getScriptParams();
        const baseUrl = BASE_URLS[ctx.environment] || BASE_URLS.SANDBOX;
        const correlationId = random.generateUUID();

        try {
            const accessToken = getWalmartAccessToken({ clientId: ctx.clientId, clientSecret: ctx.clientSecret, baseUrl, correlationId });
            const centers = getAllFulfillmentCenters({ accessToken, baseUrl, correlationId, environment: ctx.environment });
            context.response.writePage(buildSelectForm(centers, errorMessage));
        } catch (e) {
            log.error('Failed to fetch Walmart fulfillment centers', { errorName: e && e.name, errorMessage: e && e.message });
            context.response.writePage(buildSelectForm([], `Failed to load fulfillment centers from Walmart: ${e && e.message}`));
        }
    }

    function buildSelectForm(centers, errorMessage) {
        const form = serverWidget.createForm({ title: 'Update Walmart Fulfillment Center' });
        if (errorMessage) {
            form.addPageInitMessage({ type: message.Type.ERROR, title: 'Error', message: errorMessage });
        }
        const group = addSingleColumnGroup(form, 'custpage_select_group');

        const introField = form.addField({ id: 'custpage_select_intro', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
        introField.defaultValue = centers.length
            ? '<p>Choose the fulfillment center to update. The next page loads its current values -- '
                + 'every field must still be reviewed before submitting, since this is a full-replacement PUT.</p>'
            : '<p>No fulfillment centers were returned, or the request failed -- see the error above.</p>';

        const centerField = form.addField({ id: 'custpage_ship_node_id', type: serverWidget.FieldType.SELECT, label: 'Fulfillment Center', container: group });
        centers.forEach((center) => {
            centerField.addSelectOption({
                value: center.shipNode,
                text: `${center.shipNodeName || '(unnamed)'} -- customNodeId: ${center.customNodeId || 'n/a'} -- shipNode: ${center.shipNode}`
            });
        });
        centerField.isMandatory = true;

        const centersJsonField = form.addField({ id: 'custpage_centers_json', type: serverWidget.FieldType.LONGTEXT, label: 'Centers JSON', container: group });
        centersJsonField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
        centersJsonField.defaultValue = JSON.stringify(centers);

        form.addSubmitButton({ label: 'Load For Editing' });
        const actionField = form.addField({ id: 'custpage_action', type: serverWidget.FieldType.TEXT, label: 'Action', container: group });
        actionField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
        actionField.defaultValue = ACTION.SELECT;

        return form;
    }

    /** STEP 1 -> STEP 2: find the chosen center in the carried-forward list and render the pre-filled edit form. */
    function handleSelect(context) {
        const p = context.request.parameters;
        const centers = safeJsonParse(p.custpage_centers_json || '[]', null, 'carried-forward centers list');
        const center = centers.find((c) => String(c.shipNode) === String(p.custpage_ship_node_id));

        if (!center) {
            context.response.writePage(buildSelectForm(centers, 'Selected fulfillment center was not found -- please choose again.'));
            return;
        }

        context.response.writePage(buildEditForm(null, paramsFromCenter(center)));
    }

    /** Reverse of buildFulfillmentCenterPayload() below -- converts a raw Walmart fulfillment center object into custpage_* form values. */
    function paramsFromCenter(center) {
        const address = center.postalAddress || {};
        const twoDay = (center.shippingDetails
            && center.shippingDetails[0]
            && center.shippingDetails[0].twoDayShipping
            && center.shippingDetails[0].twoDayShipping[0]) || {};
        const includesTwoDay = Array.isArray(center.distributorSupportedServices)
            && center.distributorSupportedServices.includes('TWO_DAY_DELIVERY');
        const calendar = center.calendarDayConfiguration;

        const p = {
            custpage_ship_node_id: center.shipNode,
            custpage_ship_node_name: center.shipNodeName || '',
            custpage_custom_node_id: center.customNodeId || '',
            custpage_status: center.status || 'ACTIVE',
            custpage_time_zone: center.timeZone || 'EST',
            custpage_address_line1: address.addressLine1 || '',
            custpage_address_line2: address.addressLine2 || '',
            custpage_city: address.city || '',
            custpage_state: address.state || '',
            custpage_country: address.country || 'USA',
            custpage_postal_code: address.postalCode || '',
            custpage_two_day: includesTwoDay ? 'T' : 'F',
            custpage_carrier_method_name: twoDay.carrierMethodName || CARRIER_METHOD_NAMES[0],
            custpage_carrier_method_type: twoDay.carrierMethodType || CARRIER_METHOD_TYPES[0],
            custpage_configure_calendar: calendar ? 'T' : 'F'
        };

        DAYS_OF_WEEK.forEach((day) => {
            const daySchedule = calendar && calendar.standardProcessingSchedule && calendar.standardProcessingSchedule[day];
            p[`custpage_working_${day}`] = daySchedule && daySchedule.isWorkingDay ? 'T' : 'F';
            p[`custpage_cutoff_${day}`] = (daySchedule && daySchedule.cutOffTime) || DEFAULT_CUTOFF_TIME;
        });
        p.custpage_additional_days_off = ((calendar && calendar.additionalDaysOff) || []).join('\n');

        return p;
    }

    function addTextField(form, group, id, label, defaultValue, isMandatory) {
        const field = form.addField({ id, type: serverWidget.FieldType.TEXT, label, container: group });
        if (defaultValue) {
            field.defaultValue = defaultValue;
        }
        if (isMandatory) {
            field.isMandatory = true;
        }
        return field;
    }

    /** STEP 2: same fields as the create Suitelet's form, pre-filled from `p` (see paramsFromCenter above). "shipNode" itself is shown read-only and carried as a hidden field. */
    function buildEditForm(errorMessage, p) {
        const form = serverWidget.createForm({ title: `Update Fulfillment Center -- ${p.custpage_ship_node_name || p.custpage_ship_node_id}` });
        if (errorMessage) {
            form.addPageInitMessage({ type: message.Type.ERROR, title: 'Error', message: errorMessage });
        }

        const group = addSingleColumnGroup(form, 'custpage_fields_group');

        const shipNodeIdField = form.addField({ id: 'custpage_ship_node_id_label', type: serverWidget.FieldType.LABEL, label: 'Walmart Ship Node ID (not editable)', container: group });
        const shipNodeIdNoteField = form.addField({ id: 'custpage_ship_node_id_note', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
        shipNodeIdNoteField.defaultValue = `<p style="margin:2px 0 12px;font-size:13px;color:#333;">${p.custpage_ship_node_id}</p>`;
        const shipNodeIdHiddenField = form.addField({ id: 'custpage_ship_node_id', type: serverWidget.FieldType.TEXT, label: 'Ship Node ID', container: group });
        shipNodeIdHiddenField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
        shipNodeIdHiddenField.defaultValue = p.custpage_ship_node_id;

        const fullReplacementNoteField = form.addField({ id: 'custpage_full_replacement_note', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
        fullReplacementNoteField.defaultValue = '<p style="margin:2px 0 12px;font-size:12px;color:#666;">'
            + 'This PUTs a full replacement to Walmart -- every field below is pre-filled with the current live value, '
            + 'but review each one before submitting; any field left wrong will overwrite (not merge with) what Walmart '
            + 'currently has stored for this facility.</p>';

        addTextField(form, group, 'custpage_ship_node_name', 'Facility Name', p.custpage_ship_node_name, true);
        addTextField(form, group, 'custpage_custom_node_id', 'Custom Node ID', p.custpage_custom_node_id, false);

        const statusField = form.addField({ id: 'custpage_status', type: serverWidget.FieldType.SELECT, label: 'Status', container: group });
        Object.keys(STATUSES).forEach((value) => statusField.addSelectOption({ value, text: STATUSES[value], isSelected: value === p.custpage_status }));
        statusField.isMandatory = true;

        const timeZoneField = form.addField({ id: 'custpage_time_zone', type: serverWidget.FieldType.SELECT, label: 'Time Zone', container: group });
        TIME_ZONES.forEach((tz) => timeZoneField.addSelectOption({ value: tz, text: tz, isSelected: tz === p.custpage_time_zone }));
        timeZoneField.isMandatory = true;

        addTextField(form, group, 'custpage_address_line1', 'Address Line 1', p.custpage_address_line1, true);
        addTextField(form, group, 'custpage_address_line2', 'Address Line 2', p.custpage_address_line2, false);
        addTextField(form, group, 'custpage_city', 'City', p.custpage_city, true);
        addTextField(form, group, 'custpage_state', 'State', p.custpage_state, true);
        addTextField(form, group, 'custpage_country', 'Country', p.custpage_country, true);
        addTextField(form, group, 'custpage_postal_code', 'Postal Code', p.custpage_postal_code, true);

        const twoDayField = form.addField({ id: 'custpage_two_day', type: serverWidget.FieldType.SELECT, label: 'Supports Two-Day Delivery', container: group });
        twoDayField.addSelectOption({ value: 'T', text: 'Yes', isSelected: p.custpage_two_day !== 'F' });
        twoDayField.addSelectOption({ value: 'F', text: 'No', isSelected: p.custpage_two_day === 'F' });
        twoDayField.isMandatory = true;

        const carrierNameField = form.addField({ id: 'custpage_carrier_method_name', type: serverWidget.FieldType.SELECT, label: 'Carrier Method Name', container: group });
        CARRIER_METHOD_NAMES.forEach((name) => carrierNameField.addSelectOption({ value: name, text: name, isSelected: name === p.custpage_carrier_method_name }));
        carrierNameField.isMandatory = true;

        const carrierTypeField = form.addField({ id: 'custpage_carrier_method_type', type: serverWidget.FieldType.SELECT, label: 'Carrier Method Type', container: group });
        CARRIER_METHOD_TYPES.forEach((type) => carrierTypeField.addSelectOption({ value: type, text: type, isSelected: type === p.custpage_carrier_method_type }));
        carrierTypeField.isMandatory = true;

        const calendarField = form.addField({ id: 'custpage_configure_calendar', type: serverWidget.FieldType.SELECT, label: 'Configure Processing Schedule', container: group });
        calendarField.addSelectOption({ value: 'T', text: 'Yes', isSelected: p.custpage_configure_calendar === 'T' });
        calendarField.addSelectOption({ value: 'F', text: 'No', isSelected: p.custpage_configure_calendar !== 'T' });
        calendarField.isMandatory = true;

        const calendarHelpField = form.addField({ id: 'custpage_calendar_help', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
        calendarHelpField.defaultValue = '<p style="color:#666;font-size:13px;">If Yes, review which days this facility processes orders and '
            + `each day's cutoff time. Leave as No to omit this from the request entirely.</p>`;

        DAYS_OF_WEEK.forEach((day) => {
            const dayDividerField = form.addField({
                id: `custpage_day_divider_${day}`, type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group
            });
            dayDividerField.defaultValue = `<h4 style="margin:16px 0 4px;padding-top:12px;border-top:1px solid #ddd;">${DAY_LABELS[day]}</h4>`;

            const workingField = form.addField({
                id: `custpage_working_${day}`, type: serverWidget.FieldType.CHECKBOX,
                label: `${DAY_LABELS[day]} -- Working Day`, container: group
            });
            workingField.defaultValue = p[`custpage_working_${day}`] === 'T' ? 'T' : 'F';

            addTextField(form, group, `custpage_cutoff_${day}`, `${DAY_LABELS[day]} -- Cutoff Time (HH:mm)`,
                p[`custpage_cutoff_${day}`] || DEFAULT_CUTOFF_TIME, false);
        });

        const additionalDaysOffField = form.addField({
            id: 'custpage_additional_days_off', type: serverWidget.FieldType.LONGTEXT,
            label: 'Additional Days Off (one yyyy-MM-dd date per line)', container: group
        });
        if (p.custpage_additional_days_off) additionalDaysOffField.defaultValue = p.custpage_additional_days_off;

        form.addSubmitButton({ label: 'Update Fulfillment Center' });
        const actionField = form.addField({ id: 'custpage_action', type: serverWidget.FieldType.TEXT, label: 'Action', container: group });
        actionField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
        actionField.defaultValue = ACTION.UPDATE;

        return form;
    }

    function buildResultPage(params) {
        const { success, message: msg, correlationId, responseBody } = params;
        const form = serverWidget.createForm({ title: success ? 'Fulfillment Center Updated' : 'Fulfillment Center Update Failed' });
        const text = [
            success ? 'Success.' : 'Error.',
            msg,
            correlationId ? `\n\ncorrelationId: ${correlationId} (reference this if you need to ask Walmart support about this facility)` : '',
            responseBody ? `\n\nWalmart response:\n${responseBody}` : ''
        ].filter(Boolean).join(' ');

        const resultField = form.addField({ id: 'custpage_result', type: serverWidget.FieldType.LONGTEXT, label: 'Result' });
        resultField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
        resultField.defaultValue = text;

        const nextField = form.addField({ id: 'custpage_next', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
        nextField.defaultValue = '<div style="padding:10px 0;">'
            + `<a href="${buildSuiteletUrl()}" style="${BUTTON_STYLE}">Update another fulfillment center</a>`
            + '</div>';

        return form;
    }

    function handleUpdate(context) {
        const p = context.request.parameters;

        const required = {
            'Ship Node ID': p.custpage_ship_node_id,
            'Fulfillment Center Name': p.custpage_ship_node_name,
            'Custom Node ID': p.custpage_custom_node_id,
            'Address Line 1': p.custpage_address_line1,
            'City': p.custpage_city,
            'State': p.custpage_state,
            'Country': p.custpage_country,
            'Postal Code': p.custpage_postal_code
        };

        const missing = Object.keys(required).filter((label) => !required[label] || !String(required[label]).trim());
        if (missing.length > 0) {
            context.response.writePage(buildEditForm(`Missing required field(s): ${missing.join(', ')}.`, p));
            return;
        }

        if (p.custpage_configure_calendar === 'T') {
            const badCutoffDays = DAYS_OF_WEEK
                .filter((day) => !CUTOFF_TIME_PATTERN.test((p[`custpage_cutoff_${day}`] || DEFAULT_CUTOFF_TIME).trim()))
                .map((day) => DAY_LABELS[day]);
            if (badCutoffDays.length) {
                context.response.writePage(buildEditForm(`Cutoff time must be HH:mm for: ${badCutoffDays.join(', ')}.`, p));
                return;
            }

            const badDates = parseAdditionalDaysOff(p.custpage_additional_days_off).filter((d) => !ISO_DATE_PATTERN.test(d));
            if (badDates.length) {
                context.response.writePage(buildEditForm(`Additional Days Off must be yyyy-MM-dd -- invalid: ${badDates.join(', ')}.`, p));
                return;
            }
        }

        const payload = buildFulfillmentCenterPayload(p);
        const ctx = getScriptParams();
        const baseUrl = BASE_URLS[ctx.environment] || BASE_URLS.SANDBOX;
        const correlationId = random.generateUUID();

        try {
            const accessToken = getWalmartAccessToken({ clientId: ctx.clientId, clientSecret: ctx.clientSecret, baseUrl, correlationId });
            const response = updateFulfillmentCenter({ accessToken, baseUrl, correlationId, environment: ctx.environment, payload });

            context.response.writePage(buildResultPage({
                success: true,
                message: `Fulfillment center "${p.custpage_ship_node_name}" updated`,
                correlationId,
                responseBody: response.body
            }));
        } catch (e) {
            log.error('Failed to update Walmart fulfillment center', {
                shipNodeId: p.custpage_ship_node_id, shipNodeName: p.custpage_ship_node_name,
                errorName: e && e.name, errorMessage: e && e.message
            });
            context.response.writePage(buildResultPage({ success: false, message: e && e.message, correlationId }));
        }
    }

    function buildFulfillmentCenterPayload(p) {
        const includeTwoDay = p.custpage_two_day === 'T';

        const shipNode = {
            shipNode: p.custpage_ship_node_id,
            shipNodeName: p.custpage_ship_node_name.trim(),
            status: p.custpage_status,
            timeZone: p.custpage_time_zone,
            customNodeId: p.custpage_custom_node_id.trim(),
            postalAddress: {
                addressLine1: p.custpage_address_line1.trim(),
                ...(p.custpage_address_line2 && p.custpage_address_line2.trim() ? { addressLine2: p.custpage_address_line2.trim() } : {}),
                city: p.custpage_city.trim(),
                state: p.custpage_state.trim(),
                country: p.custpage_country.trim(),
                postalCode: p.custpage_postal_code.trim()
            }
        };

        // Same requirement as the create Suitelet -- see its TODO for why
        // these are sent regardless of two-day support.
        shipNode.distributorSupportedServices = includeTwoDay ? ['TWO_DAY_DELIVERY'] : [];
        shipNode.shippingDetails = [{
            twoDayShipping: [{
                carrierMethodName: p.custpage_carrier_method_name.trim(),
                carrierMethodType: p.custpage_carrier_method_type.trim()
            }]
        }];

        if (p.custpage_configure_calendar === 'T') {
            shipNode.calendarDayConfiguration = buildCalendarDayConfiguration(p);
        }

        return {
            shipNodeHeader: {
                version: SHIP_NODE_HEADER_VERSION
            },
            shipNode: shipNode
        };
    }

    function buildCalendarDayConfiguration(p) {
        const standardProcessingSchedule = {};
        DAYS_OF_WEEK.forEach((day) => {
            const isWorkingDay = p[`custpage_working_${day}`] === 'T';
            standardProcessingSchedule[day] = {
                isWorkingDay,
                // Examples do not include cutoff time for non-working days
                ...(isWorkingDay ? { cutOffTime: (p[`custpage_cutoff_${day}`] || DEFAULT_CUTOFF_TIME).trim() } : {})
            };
        });

        const additionalDaysOff = parseAdditionalDaysOff(p.custpage_additional_days_off);

        return {
            standardProcessingSchedule,
            ...(additionalDaysOff.length ? { additionalDaysOff } : {})
        };
    }

    function parseAdditionalDaysOff(raw) {
        if (!raw) return [];
        return raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    }

    function logHttpResponse(title, response, correlationId) {
        log[response.code >= 200 && response.code < 300 ? 'audit' : 'error']({
            title: `${title} (correlationId=${correlationId})`,
            details: JSON.stringify({ code: response.code, headers: response.headers, body: response.body })
        });
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

    function buildSuiteletUrl() {
        const script = runtime.getCurrentScript();
        return url.resolveScript({ scriptId: script.id, deploymentId: script.deploymentId, returnExternalUrl: false });
    }

    function addSingleColumnGroup(form, id) {
        const group = form.addFieldGroup({ id, label: ' ' });
        group.isSingleColumn = true;
        return id;
    }

    return { onRequest };
});
