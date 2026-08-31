/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * Tool for registering a new Walmart Fulfillment Center (AKA shipping node).
 * 
 * 
 * Script parameters:
 *   custscript_wal_create_fc_client_id  - Walmart Marketplace API Client ID
 *   custscript_wal_create_fc_secret     - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_create_fc_env        - "PRODUCTION" or "SANDBOX"
 * 
 * TODO: Not sure why you must include distributorSupportedServices: ['TWO_DAY_DELIVERY'], and set something for shippingDetails.twoDayShipping.
 *       This could be an error in the docs or a sandbox limitation. The guide
 *       https://developer.walmart.com/us-marketplace/docs/create-fulfillment-center#2-validate-the-required-fields
 *       states at least one supported shipping method must be included, but the only valid option for the API request
 *       is two day shipping https://developer.walmart.com/us-marketplace/reference/createfulfillmentcenter.
 * */

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
        CLIENT_ID: 'custscript_wal_create_fc_client_id',
        CLIENT_SECRET: 'custscript_wal_create_fc_client_secret',
        ENVIRONMENT: 'custscript_wal_create_fc_env'
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

    const ACTION = { CREATE: 'create' };

    function getScriptParams() {
        const script = runtime.getCurrentScript();
        return {
            clientId: script.getParameter({ name: PARAMS.CLIENT_ID }),
            clientSecret: script.getParameter({ name: PARAMS.CLIENT_SECRET }),
            environment: (script.getParameter({ name: PARAMS.ENVIRONMENT }) || 'SANDBOX').toUpperCase()
        }
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

    function createFulfillmentCenter(params) {
        const { accessToken, baseUrl, correlationId, environment, payload } = params;

        log.audit(`Walmart create fulfillment center request body (correlationId=${correlationId})`, JSON.stringify(payload));

        const response = https.post({
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

        logHttpResponse('Walmart create fulfillment center request', response, correlationId);
        if (response.code < 200 || response.code >= 300) {
            throw new Error(`Walmart create fulfillment center request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
        }
        return response;
    }

    function onRequest(context) {
        try {
            if (context.request.method !== 'POST') {
                context.response.writePage(buildEnterFieldsForm());
                return;
            }

            const action = context.request.parameters.custpage_action;
            if (action === ACTION.CREATE) {
                handleCreate(context);
            } else {
                context.response.writePage(buildEnterFieldsForm('Unknown action -- please start again.'));
            }
        } catch (e) {
            log.error('Create fulfillment center - unhandled error', {
                errorName: e && e.name, errorMessage: e && e.message
            });
            context.response.writePage(buildResultPage({ success: false, message: e && e.message, correlationId: null }));
        }
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

    function buildEnterFieldsForm(errorMessage, previousParams) {
        const form = serverWidget.createForm({ title: 'Create Walmart Fulfillment Center' });
        if (errorMessage) {
            form.addPageInitMessage({ type: message.Type.ERROR, title: 'Error', message: errorMessage });
        }

        const p = previousParams || {};
        const group = addSingleColumnGroup(form, 'custpage_fields_group');

        addTextField(form, group, 'custpage_ship_node_name', 'Facility Name', p.custpage_ship_node_name, true);
        addTextField(form, group, 'custpage_custom_node_id', 'Custom Node ID', p.custpage_custom_node_id, true);

        const statusField = form.addField({ id: 'custpage_status', type: serverWidget.FieldType.SELECT, label: 'Status', container: group });
        Object.keys(STATUSES).forEach((value) => statusField.addSelectOption({ value, text: STATUSES[value] }));
        statusField.defaultValue = p.custpage_status || 'ACTIVE';
        statusField.isMandatory = true;

        const timeZoneField = form.addField({ id: 'custpage_time_zone', type: serverWidget.FieldType.SELECT, label: 'Time Zone', container: group });
        TIME_ZONES.forEach((tz) => timeZoneField.addSelectOption({ value: tz, text: tz }));
        timeZoneField.defaultValue = p.custpage_time_zone || 'EST';
        timeZoneField.isMandatory = true;

        addTextField(form, group, 'custpage_address_line1', 'Address Line 1', p.custpage_address_line1, true);
        addTextField(form, group, 'custpage_address_line2', 'Address Line 2', p.custpage_address_line2, false);
        addTextField(form, group, 'custpage_city', 'City', p.custpage_city, true);
        addTextField(form, group, 'custpage_state', 'State', p.custpage_state, true);
        addTextField(form, group, 'custpage_country', 'Country', p.custpage_country || 'USA', true);
        addTextField(form, group, 'custpage_postal_code', 'Postal Code', p.custpage_postal_code, true);

        // Old solution -- CHECKBOX. isMandatory is a no-op on a checkbox (unchecked
        // is already a complete, valid answer), so this was replaced with a
        // required Yes/No SELECT to force an explicit choice. Kept here
        // commented out in case we need to revert.
        // const twoDayField = form.addField({ id: 'custpage_two_day', type: serverWidget.FieldType.CHECKBOX, label: 'Supports Two-Day Delivery', container: group });
        // twoDayField.defaultValue = p.custpage_two_day === 'T' ? 'T' : 'F';

        // Values stay 'T'/'F' so the rest of the code (includeTwoDay checks) didn't need to change.
        const twoDayField = form.addField({ id: 'custpage_two_day', type: serverWidget.FieldType.SELECT, label: 'Supports Two-Day Delivery', container: group });
        twoDayField.addSelectOption({ value: 'T', text: 'Yes' });
        twoDayField.addSelectOption({ value: 'F', text: 'No' });
        twoDayField.defaultValue = p.custpage_two_day === 'F' ? 'F' : 'T';
        twoDayField.isMandatory = true;

        // Old solution -- carrier fields were free text and only shown/required
        // alongside "Supports Two-Day Delivery". Kept here commented out in case
        // we need to revert; see the Get Carrier Methods finding for why this
        // changed (shippingDetails is required for EVERY facility, not just
        // two-day-capable ones, and Walmart validates carrier name/type against
        // a known list, not arbitrary text).
        // const twoDayHelpField = form.addField({ id: 'custpage_two_day_help', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
        // twoDayHelpField.defaultValue = '<p style="color:#666;font-size:13px;">If checked, fill in the carrier used for two-day shipments below.</p>';
        // addTextField(form, group, 'custpage_carrier_method_name', 'Carrier Method Name (e.g. FEDEX)', p.custpage_carrier_method_name, false);
        // addTextField(form, group, 'custpage_carrier_method_type', 'Carrier Method Type (e.g. GROUND)', p.custpage_carrier_method_type, false);

        // const carrierHelpField = form.addField({ id: 'custpage_carrier_help', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
        // carrierHelpField.defaultValue = '<p style="color:#666;font-size:13px;">Required regardless of two-day delivery support -- Walmart requires '
        //     + 'every fulfillment center to declare at least one shipping method (confirmed via the Get Carrier Methods API).</p>';

        const carrierNameField = form.addField({ id: 'custpage_carrier_method_name', type: serverWidget.FieldType.SELECT, label: 'Carrier Method Name', container: group });
        CARRIER_METHOD_NAMES.forEach((name) => carrierNameField.addSelectOption({ value: name, text: name }));
        carrierNameField.defaultValue = p.custpage_carrier_method_name || CARRIER_METHOD_NAMES[0];
        carrierNameField.isMandatory = true;

        const carrierTypeField = form.addField({ id: 'custpage_carrier_method_type', type: serverWidget.FieldType.SELECT, label: 'Carrier Method Type', container: group });
        CARRIER_METHOD_TYPES.forEach((type) => carrierTypeField.addSelectOption({ value: type, text: type }));
        carrierTypeField.defaultValue = p.custpage_carrier_method_type || CARRIER_METHOD_TYPES[0];
        carrierTypeField.isMandatory = true;
    
        // Old solution -- CHECKBOX. Kept here commented out in case we need to
        // revert; replaced with a required Yes/No SELECT for consistency with
        // "Supports Two-Day Delivery" above.
        // const calendarField = form.addField({ id: 'custpage_configure_calendar', type: serverWidget.FieldType.CHECKBOX, label: 'Configure Processing Schedule', container: group });
        // calendarField.defaultValue = p.custpage_configure_calendar === 'T' ? 'T' : 'F';

        const calendarField = form.addField({ id: 'custpage_configure_calendar', type: serverWidget.FieldType.SELECT, label: 'Configure Processing Schedule', container: group });
        calendarField.addSelectOption({ value: 'T', text: 'Yes' });
        calendarField.addSelectOption({ value: 'F', text: 'No' });
        calendarField.defaultValue = p.custpage_configure_calendar === 'T' ? 'T' : 'F';
        calendarField.isMandatory = true;

        const calendarHelpField = form.addField({ id: 'custpage_calendar_help', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
        calendarHelpField.defaultValue = '<p style="color:#666;font-size:13px;">If Yes, set which days this facility processes orders and '
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
            // Sensible default: Mon-Fri working, Sat/Sun off.
            const defaultWorking = day !== 'saturday' && day !== 'sunday';
            workingField.defaultValue = p[`custpage_working_${day}`] != null
                ? (p[`custpage_working_${day}`] === 'T' ? 'T' : 'F')
                : (defaultWorking ? 'T' : 'F');

            addTextField(form, group, `custpage_cutoff_${day}`, `${DAY_LABELS[day]} -- Cutoff Time (HH:mm)`,
                p[`custpage_cutoff_${day}`] || DEFAULT_CUTOFF_TIME, false);
        });

        const additionalDaysOffField = form.addField({
            id: 'custpage_additional_days_off', type: serverWidget.FieldType.LONGTEXT,
            label: 'Additional Days Off (one yyyy-MM-dd date per line)', container: group
        });
        if (p.custpage_additional_days_off) additionalDaysOffField.defaultValue = p.custpage_additional_days_off;

        form.addSubmitButton({ label: 'Create Fulfillment Center' });
        const actionField = form.addField({ id: 'custpage_action', type: serverWidget.FieldType.TEXT, label: 'Action', container: group });
        actionField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
        actionField.defaultValue = ACTION.CREATE;

        return form;
    }

    function buildResultPage(params) {
        const { success, message, correlationId, responseBody } = params;
        const form = serverWidget.createForm({ title: success ? 'Fulfillment Center Created' : 'Fulfillment Center Creation Failed'});
        const text = [
            success ? 'Success.' : 'Error.',
            message,
            correlationId ? `\n\ncorrelationId: ${correlationId} (reference this if you need to ask Walmart support about this facility)` : '',
            responseBody ? `\n\nWalmart response:\n${responseBody}` : ''
        ].filter(Boolean).join(' ');

        const resultField = form.addField({ id: 'custpage_result', type: serverWidget.FieldType.LONGTEXT, label: 'Result' });
        resultField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
        resultField.defaultValue = text;

        const nextField = form.addField({ id: 'custpage_next', type: serverWidget.FieldType.INLINEHTML, label: ' '});
        nextField.defaultValue = '<div style="padding:10px 0;">'
            + `<a href="${buildSuiteletUrl()}" style="${BUTTON_STYLE}">Create another fulfillment center</a>`
            + '</div>';

        return form;
    }

    function handleCreate(context) {
        const p = context.request.parameters;

        const required = {
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
            context.response.writePage(buildEnterFieldsForm(`Missing required field(s): ${missing.join(', ')}.`, p));
            return;
        }

        if (p.custpage_configure_calendar === 'T') {
            const badCutoffDays = DAYS_OF_WEEK
                .filter((day) => !CUTOFF_TIME_PATTERN.test((p[`custpage_cutoff_${day}`] || DEFAULT_CUTOFF_TIME).trim()))
                .map((day) => DAY_LABELS[day]);
            if (badCutoffDays.length) {
                context.response.writePage(buildEnterFieldsForm(`Cutoff time must be HH:mm for: ${badCutoffDays.join(', ')}.`, p));
                return;
            }

            const badDates = parseAdditionalDaysOff(p.custpage_additional_days_off).filter((d) => !ISO_DATE_PATTERN.test(d));
            if (badDates.length) {
                context.response.writePage(buildEnterFieldsForm(`Additional Days Off must be yyyy-MM-dd -- invalid: ${badDates.join(', ')}.`, p));
                return;
            }
        }

        const payload = buildFulfillmentCenterPayload(p);
        const ctx = getScriptParams();
        const baseUrl = BASE_URLS[ctx.environment] || BASE_URLS.SANDBOX;
        const correlationId = random.generateUUID();

        try {
            const accessToken = getWalmartAccessToken({ clientId: ctx.clientId, clientSecret: ctx.clientSecret, baseUrl, correlationId });
            const response = createFulfillmentCenter({ accessToken, baseUrl, correlationId, environment: ctx.environment, payload });

            context.response.writePage(buildResultPage({
                success: true,
                message: `Fulfillment center "${p.custpage_ship_node_name}" created`,
                correlationId,
                responseBody: response.body
            }));
        } catch (e) {   
            log.error('Failed to create Walmart fulfillment center', {
                shipNodeName: p.custpage_ship_node_name, errorName: e && e.name, errorMessage: e && e.message
            });
            context.response.writePage(buildResultPage({ success: false, message: e && e.message, correlationId }));
        }
    }

    function buildFulfillmentCenterPayload(p) {
        const includeTwoDay = p.custpage_two_day === 'T';

        const shipNode = {
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

        // TODO: for some reason the API requires the payload to include distributor supported services
        // and shipping details. However, two day shipping options are the only allowed values. I'm not
        // sure how to create a fulfillment center that won't support two day shipping with this APIs.
        // https://developer.walmart.com/us-marketplace/reference/createfulfillmentcenter
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
            shipNode: [shipNode]
        };
    }

    function buildCalendarDayConfiguration(p) {
        const standardProcessingSchedule = {};
        DAYS_OF_WEEK.forEach((day) => {
            standardProcessingSchedule[day] = {
                isWorkingDay: p[`custpage_working_${day}`] === 'T',
                cutOffTime: (p[`custpage_cutoff_${day}`] || DEFAULT_CUTOFF_TIME).trim()
            }
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