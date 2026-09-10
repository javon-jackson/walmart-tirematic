/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Walmart Item Fulfillment Queue Processor
 *
 * The packages sublist only gives us a tracking number + weight per package,
 * not which item(s) are actually in it. Since these are tires shipped one per
 * package, each package's weight is matched against the fulfillment's item
 * lines by their per-unit weight (from the item record) instead. A package
 * is only assigned to a line when exactly one line's weight falls within
 * WEIGHT_TOLERANCE of that package's weight -- if two lines are close enough
 * in weight to both qualify, or no line qualifies, the fulfillment errors out
 * for manual review rather than guessing which SKU shipped in that box.
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

    const TRACKING_NUM_FIELD = 'packagetrackingnumber';
    const PACKAGE_WEIGHT_FIELD = 'packageweight';

    // How close (in the item record's weight units) a package's weight must be
    // to an item's unit weight to count as a match. Covers scale rounding, not
    // meant to absorb a real difference between two distinct tire SKUs.
    const WEIGHT_TOLERANCE = 0.5;

    // TODO: Find the expected values for this field and map them to Walmarts expected carriers.
    // NOTE: Currently handled by checking if the carrier field includes text indicating the carrier is either
    //       FedEx, UPS, or USPS.
    // Valid entries are: UPS, USPS, FedEx, Airborne, OnTrac, DHL Ecommerce - US, DHL,
    // LS (LaserShip), UDS (United Delivery Service), UPSMI (UPS Mail Innovations),
    // FDX, PILOT, ESTES, SAIA, FDS Express, Seko Worldwide, HIT Delivery, FEDEXSP (FedEx SmartPost),
    // RL Carriers, Metropolitan Warehouse & Delivery, China Post, YunExpress,Yellow Freight Sys,
    // AIT Worldwide Logistics, Chukou1, Sendle, Landmark Global, Sunyou, Yanwen, 4PX, GLS, OSM Worldwide,
    // FIRST MILE, AM Trucking, CEVA, India Post, SF Express, CNE, TForce Freight, AxleHire, LSO, Royal Mail,
    // ABF Freight System, WanB, Roadrunner Freight, Meyer Distribution, AAA Cooper, Canada Post,
    // Southeastern Freight Lines, Japan Post, Correos de Mexico, XPO Logistics, JD Logistics, YDH, JCEX, Flyt,
    // Deutsche Post, Better Trucks, Asendia, SFC, UBI, ePost Global, YF Logistics, RXO, Estes Express, Shypmax,
    // WIN.IT America, PITT OHIO, PostNord Sweden, Equick, Whistl, Tusou, Shiprocket, USPS First Class Mail, DTDC,
    // PTS.
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
            // TODO: Currently only handles one carrier per fulfillment record.
            let shippingCarrier = null;
            const rawShippingCarrier = (fulfillmentRecord.getValue({ fieldId: SHIPPING_CARRIER_FIELD })).toLowerCase();
            if (rawShippingCarrier.includes("fedex")) {
                shippingCarrier = "FedEx";
            } else if (rawShippingCarrier.includes("usps")) {
                shippingCarrier = "USPS";
            } else if (rawShippingCarrier.includes("ups")) {
                shippingCarrier = "UPS";
            } else {
                throw new Error(`Unrecognized shipping carrier ${rawShippingCarrier}.`);
            }

            const shipDateTime = Date.now();

            const itemLines = getFulfillmentItemLines(fulfillmentRecord);
            const packages = getFulfillmentPackages(fulfillmentRecord);
            const matches = matchPackagesToItemLines(packages, itemLines);

            const payload = buildShipmentPayload({ orderDetails, matches, shipDateTime, carrier: shippingCarrier});

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

    /**
     * One orderLineStatus entry per matched package, grouped by Walmart
     * lineNumber -- a line whose quantity spanned multiple packages (several
     * tires, same SKU) gets multiple entries under that same lineNumber, each
     * with that specific package's own trackingInfo.
     */
    function buildShipmentPayload(params) {
        const { orderDetails, matches, shipDateTime, carrier } = params;

        const lineNumbersBySku = buildLineNumbersBySku(orderDetails);
        const methodCode = orderDetails.shippingInfo && orderDetails.shippingInfo.methodCode;

        const statusesByLineNumber = {};
        matches.forEach((match) => {
            const lineNumber = lineNumbersBySku[match.sku];
            if (!lineNumber) {
                throw new Error(`SKU ${match.sku} not found in Walmart order details.`);
            }
            if (!statusesByLineNumber[lineNumber]) statusesByLineNumber[lineNumber] = [];
            statusesByLineNumber[lineNumber].push({
                status: 'Shipped',
                statusQuantity: {
                    unitOfMeasurement: 'EACH',
                    amount: '1'
                },
                trackingInfo: {
                    shipDateTime,
                    methodCode,
                    carrierName: { carrier },
                    trackingNumber: match.trackingNum
                }
            });
        });

        const orderLine = Object.keys(statusesByLineNumber).map((lineNumber) => ({
            lineNumber,
            orderLineStatuses: {
                orderLineStatus: statusesByLineNumber[lineNumber]
            }
        }));

        return {
            orderShipment: {
                orderLines: {
                    orderLine
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

    function lookupItemDetails(itemInternalId) {
        if (!itemInternalId) return null;
        const result = search.lookupFields({
            type: search.Type.ITEM,
            id: itemInternalId,
            columns: ['itemid', 'weight']
        });
        if (!result.itemid) return null;
        return { sku: result.itemid, weight: Number(result.weight) };
    }

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

    /** One entry per item line, with that item's per-unit weight (from the item record) and quantity ordered. */
    function getFulfillmentItemLines(fulfillmentRecord) {
        const linesBySku = {};
        const lineCount = fulfillmentRecord.getLineCount({ sublistId: 'item' });
        for (let i = 0; i < lineCount; i++) {
            const itemInternalId = fulfillmentRecord.getSublistValue({ sublistId: 'item', line: i, fieldId: 'item' });
            const quantity = Number(fulfillmentRecord.getSublistValue({ sublistId: 'item', line: i, fieldId: 'quantity' }));
            const itemDetails = lookupItemDetails(itemInternalId);
            if (!itemDetails || !quantity) continue;

            if (!linesBySku[itemDetails.sku]) {
                linesBySku[itemDetails.sku] = { sku: itemDetails.sku, weight: itemDetails.weight, quantity: 0 };
            }
            linesBySku[itemDetails.sku].quantity += quantity;
        }
        return Object.values(linesBySku);
    }

    /** Tracking number + weight per package -- no item content info available. */
    function getFulfillmentPackages(fulfillmentRecord) {
        const packages = [];
        const packageCount = fulfillmentRecord.getLineCount({ sublistId: 'package' });
        for (let i = 0; i < packageCount; i++) {
            const trackingNum = fulfillmentRecord.getSublistValue({ sublistId: 'package', line: i, fieldId: TRACKING_NUM_FIELD });
            const weight = Number(fulfillmentRecord.getSublistValue({ sublistId: 'package', line: i, fieldId: PACKAGE_WEIGHT_FIELD }));
            if (trackingNum && weight) {
                packages.push({ trackingNum, weight });
            }
        }
        return packages;
    }

    /**
     * Matches each package to an item line by weight (one tire per package,
     * so package weight ~= that tire's unit weight). Multiple lines with the
     * same or close weight is expected (e.g. several tires of similar size
     * in one order) -- when more than one line with remaining quantity falls
     * within WEIGHT_TOLERANCE, the closest weight match wins, with ties
     * broken by item line order. Only a package matching zero lines errors
     * out, since there's nothing reasonable left to guess at that point.
     */
    function matchPackagesToItemLines(packages, itemLines) {
        const remainingQtyBySku = {};
        itemLines.forEach((line) => {
            remainingQtyBySku[line.sku] = line.quantity;
        });

        const matches = packages.map((pkg) => {
            const candidates = itemLines.filter((line) => (
                remainingQtyBySku[line.sku] > 0 &&
                Math.abs(line.weight - pkg.weight) <= WEIGHT_TOLERANCE
            ));

            if (candidates.length === 0) {
                throw new Error(`No item weight matches package weight ${pkg.weight} (trackingNum=${pkg.trackingNum}).`);
            }

            const closest = candidates.reduce((best, line) => (
                Math.abs(line.weight - pkg.weight) < Math.abs(best.weight - pkg.weight) ? line : best
            ));

            remainingQtyBySku[closest.sku] -= 1;
            return { sku: closest.sku, trackingNum: pkg.trackingNum };
        });

        const unmatchedSkus = Object.keys(remainingQtyBySku).filter((sku) => remainingQtyBySku[sku] > 0);
        if (unmatchedSkus.length > 0) {
            throw new Error(`No package matched for item(s): ${unmatchedSkus.join(', ')}.`);
        }

        return matches;
    }

    return {
        getInputData,
        map
    }
});
