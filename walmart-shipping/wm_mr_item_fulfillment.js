/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * 
 * Walmart Item Fulfillment Queue Processor
 *
 */
define(['N/record', 'N/search', 'N/runtime', 'N/https', 'N/encode', 'N/crypto/random'], 
    (record, search, runtime, https, encode, random) => {

    const QUEUE_RECORD = {
        TYPE: 'customrecord_wal_item_fulfillment_queue',
        FIELDS: {
            ITEM_FULFILLMENT: 'custrecord_wal_ffq_item_fulfillment',
            SALES_ORDER: 'custrecord_wal_ffq_sales_order',
            PURCHASE_ORDER_ID: 'custrecord_wal_ffq_po_id',
            STATUS: 'custrecord_wal_ffq_status',
            ERROR: 'custrecord_wal_ffq_error',
            PROCESSED_DATE: 'custrecord_wal_ffq_processed_date'
        }
    };

    const SCRIPT_PARAMS = {
        CLIENT_ID: 'custscript_wal_ffq_proc_client_id',
        CLIENT_SECRET: 'custscript_wal_ffq_proc_client_secret',
        ENVIRONMENT: 'custscript_wal_ffq_proc_env'
    };

    const BASE_URLS = {
            PRODUCTION: 'https://marketplace.walmartapis.com',
            SANDBOX: 'https://sandbox.walmartapis.com'
    };

    // TODO: confirm field ids
    const TRACKING_NUM_FIELD = 'packagetrackingnumber';
    const SHIPPING_CARRIER_FIELD = 'custbody_pacejet_shipped_method';

    function getScriptParams() {
        const script = runtime.getCurrentScript();
        return {
            clientId: script.getParameter({ name: SCRIPT_PARAMS.CLIENT_ID }),
            clientSecret: script.getParameter({ name: SCRIPT_PARAMS.CLIENT_SECRET }),
            environment: (script.getParameter({ name: SCRIPT_PARAMS.ENVIRONMENT }) || 'SANDBOX').toUpperCase() 
        }
    }

    function getInputData() {
        return search.create({
            type: QUEUE_RECORD.TYPE,
            filters: [[QUEUE_RECORD.FIELDS.STATUS, 'is', 'Pending']],
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: QUEUE_RECORD.FIELDS.ITEM_FULFILLMENT }),
                search.createColumn({ name: QUEUE_RECORD.FIELDS.SALES_ORDER }),
                search.createColumn({ name: QUEUE_RECORD.FIELDS.PURCHASE_ORDER_ID })
            ]
        });
    }

    function map(context) {
        const result = JSON.parse(context.value);
        const ctx = getScriptParams();
        const queueRecordId = result.id;
        const fulfillmentId = result.values[QUEUE_RECORD.FIELDS.ITEM_FULFILLMENT].value;
        const salesOrderId = result.values[QUEUE_RECORD.FIELDS.SALES_ORDER].value;
        const purchaseOrderId = result.values[QUEUE_RECORD.FIELDS.PURCHASE_ORDER_ID];

        try {
            if (!TRACKING_NUM_FIELD || !SHIPPING_CARRIER_FIELD) {
                throw new Error('Missing field ID for tracking number or shipping carrier.');
            }
            const fulfillmentRecord = record.load({
                type: record.Type.ITEM_FULFILLMENT,
                id: fulfillmentId
            });

            const env = ctx.environment;
            const baseUrl = BASE_URLS[env];
            const correlationId = random.generateUUID();
            const accessToken = getWalmartAccessToken({ clientId: ctx.clientId, clientSecret: ctx.clientSecret, baseUrl, correlationId});
            const orderDetails = getOrderDetails({ accessToken, baseUrl, purchaseOrderId, correlationId, environment: env });
            const shippingCarrier = fulfillmentRecord.getValue({ fieldId: SHIPPING_CARRIER_FIELD });
            const shipDateTime = Date.now();

            const payload = buildShipmentPayload({ fulfillmentRecord, orderDetails, shipDateTime, carrier: shippingCarrier});
            
            submitShippingConfirmation({ accessToken, baseUrl, purchaseOrderId, correlationId, environment: env, payload });

            updateQueueRecord({ queueRecordId, status: 'Complete' });
        } catch (error) {
            updateQueueRecord({
                queueRecordId,
                status: 'Error',
                errorMessage: (error && error.message) || String(error)
            });
        }
    }

    function updateQueueRecord(params) {
        const { queueRecordId, status, errorMessage } = params;
        record.submitFields({
            type: QUEUE_RECORD.TYPE,
            id: queueRecordId,
            values: {
                [QUEUE_RECORD.FIELDS.STATUS]: status,
                [QUEUE_RECORD.FIELDS.ERROR]: errorMessage || '',
                [QUEUE_RECORD.FIELDS.PROCESSED_DATE]: status === 'Complete' ? new Date() : null
            },
            options: {
                enableSourcing: false,
                ignoreMandatoryFields: true
            }
        });
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

    function getOrderDetails(params) {
            const { accessToken, baseUrl, purchaseOrderId, correlationId, environment } = params;

            const response = https.get({
                url: `${baseUrl}/v3/orders/${encodeURIComponent(purchaseOrderId)}`,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'WM_QOS.CORRELATION_ID': correlationId,
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'Accept': 'application/json'
                }
            });

            logHttpResponse(`Walmart order details request (purchaseOrderId=${purchaseOrderId})`, response, correlationId);
            if (response.code !== 200) {
                throw new Error(`Walmart order details request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }

            const parsed = safeJsonParse(response.body, correlationId, 'order details');
            if (!parsed.order) {
                throw new Error(`Walmart order details response missing "order" wrapper (correlationId=${correlationId}): ${response.body}`);
            }
            return parsed.order;
    }

    function buildShipmentPayload(params) {
        const { fulfillmentRecord, orderDetails, shipDateTime, carrier } = params;

        const { sku } = getFulfillmentLine(fulfillmentRecord);
        const lineNumbersBySku = buildLineNumbersBySku(orderDetails);
        const lineNumber = lineNumbersBySku[sku];
        if (!lineNumber) {
                throw new Error(`SKU ${sku} not found in Walmart order details.`)
        }
        
        const packages = getFulfillmentPackages(fulfillmentRecord);
        const orderLineStatus = packages.map((pkg) => (
            {
                status: 'Shipped',
                statusQuantity: {
                    unitOfMeasurement: 'EACH',
                    amount: '1'
                },
                trackingInfo: {
                    shipDateTime,
                    carrierName: { carrier },
                    trackingNumber: pkg.trackingNum
                }
            }
        ));

        return {
            orderShipment: {
                orderLines: {
                    orderLine: [{
                        lineNumber,
                        orderLineStatuses: {
                            orderLineStatus
                        }
                    }]
                }
            }
        }
    }

    function submitShippingConfirmation(params) {
            const { accessToken, baseUrl, purchaseOrderId, correlationId, environment, payload } = params;

            const response = https.post({
                url: `${baseUrl}/v3/orders/${encodeURIComponent(purchaseOrderId)}/shipping`,
                body: JSON.stringify(payload),
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'WM_QOS.CORRELATION_ID': correlationId,
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            logHttpResponse(`Walmart shipping confirmation request (purchaseOrderId=${purchaseOrderId})`, response, correlationId);
            if (response.code !== 200) {
                throw new Error(`Walmart shipping confirmation failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }
            return safeJsonParse(response.body, correlationId, 'shipping confirmation');
    }

    function findItemSkuByInternalId(itemInternalId) {
        if (!itemInternalId) return null;
        const result = search.lookupFields({
            type: search.Type.ITEM,
            id: itemInternalId,
            columns: ['itemid']
        });
        return result.itemid || null;
    }

    // function getFulfillmentLines(fulfillmentRecord) {
    //     const lines = [];
    //     const lineCount = fulfillmentRecord.getLineCount({ sublistId: 'item' });
    //     for (let i = 0; i < lineCount; i++) {
    //         const itemInternalId = fulfillmentRecord.getSublistValue({ sublistId: 'item', line: i, fieldId: 'item' });
    //         const sku = findItemSkuByInternalId(itemInternalId);
    //         const quantity = fulfillmentRecord.getSublistValue({ sublistId: 'item', line: i, fieldId: 'quantity'});
    //         if (sku && quantity) {
    //             lines.push({ sku, quantity: Number(quantity)});
    //         }
    //     }
    //     return lines;
    // }

    function buildLineNumbersBySku(orderDetails) {
        const orderLines = (orderDetails.orderLines && orderDetails.orderLines.orderLine) || [];
        const lineNumbersBySku = {};
        orderLines.forEach((line) => {
            const sku = line.item && line.item.sku;
            if (sku) {
                lineNumbersBySku[sku] = line.lineNumber;
            }
        });

        return lineNumbersBySku;
    }

    // TODO: currently only wired to handle one item line. Need a way to map each item to tracking number.
    // If only one item line theres only one sku, so each sku can use any of the tracking numbers.
    // If multiple item lines are involved, 
    function getFulfillmentLine(fulfillmentRecord) {
        const lineCount = fulfillmentRecord.getLineCount({ sublistId: 'item' });
        if (lineCount !== 1) {
            throw new Error(`Expected one item line. Found ${lineCount}`);
        }
        const itemInternalId = fulfillmentRecord.getSublistValue({ sublistId: 'item', line: 0, fieldId: 'item' });
        const itemSku = findItemSkuByInternalId(itemInternalId);
        return { sku: itemSku };
    }

    function getFulfillmentPackages(fulfillmentRecord) {
        const packages = [];
        const packageCount = fulfillmentRecord.getLineCount({ sublistId: 'package' });
        for (let i = 0; i < packageCount; i++) {
            const trackingNum = fulfillmentRecord.getSublistValue({ sublistId: 'package', line: i, fieldId: 'packagetrackingnumber' });
            if (trackingNum) {
                packages.push({ trackingNum });
            }
        }
        return packages;
    }

    return {
        getInputData,
        map
    }
});