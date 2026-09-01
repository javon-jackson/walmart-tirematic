/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Bulk inventory sync via Walmarts multi-ship-node inventory feed feedType = MP_INVENTORY, spec 1.5.
 * Uploads quantity per Walmart fulfillment center.
 * 
 * Feed processing can take a long time so each feed ID is stored in custom record so feed status
 * can be checked with wm_sl_feed_status.js.
 * 
 * 
 * Script parameters:
 *   custscript_wal_mninv_feed_saved_search      - internal ID of the per-location
 *                                                 saved search described above
 *   custscript_wal_mninv_feed_client_id         - Walmart Marketplace API Client ID
 *   custscript_wal_mninv_feed_client_secret     - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_mninv_feed_env               - "PRODUCTION" or "SANDBOX"
 *   custscript_wal_mninv_feed_bucket_size       - target items per bucket (default 1000,
 *                                                 same rationale as the 1.4 script)
 *   custscript_wal_mninv_feed_ship_node_map     - JSON string mapping NetSuite Location
 *                                                 internal ID -> Walmart shipNode ID, e.g.
 *                                                 {"1":"FC_TAMPA_01","4":"FC_DALLAS_01"}.
 *                                                 A Long Text field param, not code, so ops
 *                                                 can update it once real ship node IDs are
 *                                                 known without a script redeploy.
 */

define(['N/search', 'N/runtime', 'N/log', 'N/https', 'N/encode', 'N/record', 'N/crypto/random', 'N/cache'], 
    (search, runtime, log, https, encode, record, random, cache) => {

    const BASE_URLS = {
        PRODUCTION: 'https://marketplace.walmartapis.com',
        SANDBOX: 'https://sandbox.walmartapis.com'
    };

    const COLUMNS = {
        SKU: 'itemid',
        /**
         * Location IDs
         * 1: Tampa
         * 34: Decatur
         * 35: Anaheim
         * TODO: My saved search "Tires for Walmart Upload (All Locations)"
         * didn't show any inventory for any other locations. This might change in production.
        */
        LOCATION: 'inventorylocation',
        QUANTITY_AVAILABLE: 'locationquantityavailable'
    };

    const FEED_RECORD = {
        TYPE: 'customrecord_wal_feed_submission',
        FIELDS: {
            FEED_ID: 'custrecord_wal_feed_id',
            STATUS: 'custrecord_wal_feed_status',
            ENVIRONMENT: 'custrecord_wal_feed_env',
            ITEM_COUNT: 'custrecord_wal_feed_item_count',
            SUBMITTED_DATE: 'custrecord_wal_feed_submitted_date',
            BUCKET: 'custrecord_wal_feed_bucket',
            LAST_CHECKED_DATE: 'custrecord_wal_feed_last_checked',
            DETAILS: 'custrecord_wal_feed_details',
            CORRELATION_ID: 'custrecord_wal_feed_correlation_id',
            FEED_TYPE: 'custrecord_wal_feed_type',
            ITEM_TYPE: 'custrecord_wal_feed_item_type',
            // JSON array of {sku, shipNodes: [{shipNode, amount}]} so the
            // per-ship-node quantities pushed are visible on the row.
            SKUS: 'custrecord_wal_feed_skus'
        }
    };

    const FEED_STATUS = {
        RECEIVED: 'RECEIVED',
        INPROGRESS: 'INPROGRESS',
        PROCESSED: 'PROCESSED',
        ERROR: 'ERROR',
        RATE_LIMITED: 'RATE_LIMITED'
    };

    const PARAMS = {
        SAVED_SEARCH_ID: 'custscript_wal_mninv_feed_saved_search',
        CLIENT_ID: 'custscript_wal_mninv_feed_client_id',
        CLIENT_SECRET: 'custscript_wal_mninv_feed_client_secret',
        ENVIRONMENT: 'custscript_wal_mninv_feed_env',
        BUCKET_SIZE: 'custscript_wal_mninv_feed_bucket_size',
        SHIP_NODE_MAP: 'custscript_wal_mninv_feed_ship_node_map'
    }

    const QUANTITY_UNIT = 'EACH';

    // https://developer.walmart.com/us-marketplace/docs/bulk-inventory
    // https://developer.walmart.com/us-marketplace/reference/post_v3-feeds
    const INVENTORY_HEADER_VERSION = '1.5';

    const FEED_TYPE = 'MP_INVENTORY';
    const WALMART_ITEM_TYPE = 'Tires';

    // Covers one full M/R run (low-hundreds-to-low-thousands SKU catalog)
    // without recomputing the bucket count on every map() call -- 1 hour.
    const BUCKET_CACHE_TTL_SECONDS = 3600;
    const BUCKET_CACHE_NAME = 'wal_invmn_feed_buckets';

    // POST /v3/feeds?feedType=MP_INVENTORY is limited to 10 requests/hour,
    // one feed submission per bucket, so the bucket count itself must
    // never exceed this.
    const MAX_BUCKETS_PER_HOUR = 10;

    function getScriptParams() {
        const script = runtime.getCurrentScript();
        const shipNodeMapRaw = script.getParameter({ name: PARAMS.SHIP_NODE_MAP });
        let shipNodeMap = {};
        try {
            shipNodeMap = shipNodeMapRaw ? JSON.parse(shipNodeMapRaw) : {};
        } catch (e) {
            throw new Error(`${PARAMS.SHIP_NODE_MAP} is not valid JSON: ${e.message}`);
        }
        return {
            savedSearchId: script.getParameter({ name: PARAMS.SAVED_SEARCH_ID }),
            clientId: script.getParameter({ name: PARAMS.CLIENT_ID }),
            clientSecret: script.getParameter({ name: PARAMS.CLIENT_SECRET }),
            environment: (script.getParameter({ name: PARAMS.ENVIRONMENT }) || 'SANDBOX').toUpperCase(),
            bucketSize: parseInt(script.getParameter({ name: PARAMS.BUCKET_SIZE }), 10) || 1000,
            shipNodeMap
        };
    }
    
    function getBaseUrl(environment) {
        return environment === 'PRODUCTION' ? BASE_URLS.PRODUCTION : BASE_URLS.SANDBOX;
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

        if (response.code !== 200) {
            throw new Error(`Walmart token request failed (${response.code}): ${response.body}`);
        }

        const parsed = JSON.parse(response.body);
        if (!parsed.access_token) {
            throw new Error(`Walmart token response missing access_token: ${response.body}`);
        }
        return parsed.access_token;
    }

    function buildFeedPayload(items) {
        return JSON.stringify({
            inventoryHeader : {
                version: INVENTORY_HEADER_VERSION
            },
            inventory: items.map(({ sku, shipNodes }) => ({
                sku,
                shipNodes: shipNodes.map(({ shipNode, amount }) => ({
                    shipNode: shipNode,
                    quantity: {
                        unit: QUANTITY_UNIT,
                        amount: amount
                    }
                }))
            }))
        });
    }

    function buildMultipartBody(feedJson, boundary) {
        const CRLF = '\r\n';
        return `--${boundary}${CRLF}`
            + `Content-Disposition: form-data; name="file"; filename="inventory-feed-multinode.json"${CRLF}`
            + `Content-Type: application/json${CRLF}`
            + CRLF
            + feedJson + CRLF
            + `--${boundary}--${CRLF}`;
    }

    function submitInventoryFeed(params) {
        const { accessToken, baseUrl, items, correlationId } = params;

        const feedJson = buildFeedPayload(items);
        const boundary = `----WalmartInventoryFeedMultiNodeBoundary${random.generateUUID().replace(/-/g, '')}`;
        const body = buildMultipartBody(feedJson, boundary);

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

        if (response.code !== 200) {
            // responseCode is attached (not just embedded in the message) so
            // reduce()'s catch block can distinguish a 429 rate-limit from
            // any other failure without parsing this string.
            const error = new Error(`Walmart multi-node inventory feed submission failed (${response.code}): ${response.body}`);
            error.responseCode = response.code;
            throw error;
        }

        const parsed = JSON.parse(response.body);
        log.audit({ title: 'Walmart multi-node inventory feed submitted', details: parsed.feedId });
        return parsed.feedId;
    }

    function getNumBuckets(savedSearchId, bucketSize) {
        const bucketCache = cache.getCache({ name: BUCKET_CACHE_NAME, scope: cache.Scope.PRIVATE });
        const value = bucketCache.get({
            key: `numBuckets_${savedSearchId}_${bucketSize}`,
            ttl: BUCKET_CACHE_TTL_SECONDS,
            loader: () => {
                const totalCount = search.load({ id: savedSearchId }).runPaged({ pageSize: 1000 }).count;
                const computed = Math.min(MAX_BUCKETS_PER_HOUR, Math.max(1, Math.ceil(totalCount / bucketSize)));
                if (Math.ceil(totalCount / bucketSize) > MAX_BUCKETS_PER_HOUR) {
                    log.audit({
                        title: 'Bucket count capped at MAX_BUCKETS_PER_HOUR',
                        details: `savedSearchId=${savedSearchId}, totalCount=${totalCount}, bucketSize=${bucketSize}, `
                            + `uncapped=${Math.ceil(totalCount / bucketSize)}, capped=${computed}. Raise `
                            + `${PARAMS.BUCKET_SIZE} if buckets are getting too large.`
                    });
                }
                return String(computed);
            }
        });
        return parseInt(value, 10);
    }

     /**
     * Reads a value out of a search-result `values` object, handling both
     * plain values and the {value, text} shape NetSuite returns for
     * list/record joins. Prefers text -- used for the SKU column.
     */
    function getColumnValue(values, key) {
        const raw = values[key];
        if (raw === null || raw === undefined) return '';
        if (Array.isArray(raw)) {
            return raw.length ? (raw[0].text || raw[0].value || '') : '';
        }
        if (typeof raw === 'object') {
            return raw.text || raw.value || '';
        }
        return raw;
    }

    function getColumnId(values, key) {
        const raw = values[key];
        if (raw === null || raw === undefined) return '';
        if (Array.isArray(raw)) {
            return raw.length ? (raw[0].value || '') : '';
        }
        if (typeof raw === 'object') {
            return raw.value || '';
        }
        return raw;
    }

    function recordFeedSubmission(params) {
        const { feedId, bucket, itemCount, environment, correlationId, skuQuantities } = params;
        try {
            const submissionRecord = record.create({ type: FEED_RECORD.TYPE, isDynamic: false });
            submissionRecord.setValue({ fieldId: 'name', value: feedId });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.FEED_ID, value: feedId });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.STATUS, value: FEED_STATUS.RECEIVED });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.ENVIRONMENT, value: environment });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.ITEM_COUNT, value: itemCount });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.SUBMITTED_DATE, value: new Date() });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.BUCKET, value: bucket });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.CORRELATION_ID, value: correlationId });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.FEED_TYPE, value: FEED_TYPE });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.ITEM_TYPE, value: WALMART_ITEM_TYPE });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.SKUS, value: skuQuantities });
            submissionRecord.save();
        } catch (error) {
            log.error({ title: `Failed to record feed submission tracking (feedId=${feedId})`, details: error });
        }
    }

    function recordFailedFeedSubmission(params) {
        const { bucket, itemCount, environment, correlationId, skuQuantities, status, errorMessage } = params;
        try {
            const submissionRecord = record.create({ type: FEED_RECORD.TYPE, isDynamic: false });
            submissionRecord.setValue({ fieldId: 'name', value: `${status}-bucket${bucket}-${correlationId}` });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.STATUS, value: status });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.ENVIRONMENT, value: environment });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.ITEM_COUNT, value: itemCount });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.SUBMITTED_DATE, value: new Date() });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.BUCKET, value: bucket });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.CORRELATION_ID, value: correlationId });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.FEED_TYPE, value: FEED_TYPE });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.ITEM_TYPE, value: WALMART_ITEM_TYPE });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.SKUS, value: skuQuantities });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.DETAILS, value: errorMessage });
            submissionRecord.save();
        } catch (error) {
            log.error({ title: `Failed to record FAILED feed submission tracking (bucket=${bucket}, status=${status})`, details: error });
        }
    }

    function getInputData() {
        const { savedSearchId, bucketSize, shipNodeMap } = getScriptParams();

        if (!savedSearchId) {
            throw new Error(`Missing required script parameter: ${PARAMS.SAVED_SEARCH_ID}`);
        }

        if (!shipNodeMap || Object.keys(shipNodeMap).length === 0) {
            throw new Error(`Missing or empty ${PARAMS.SHIP_NODE_MAP} -- this must map every `
                + 'NetSuite Location that ships Walmart orders to a real Walmart shipNode ID before this script can run.');
        }

        // Populates the bucket-count cache up front (see getNumBuckets())
        // so it's ready before map() needs it -- doesn't load the actual
        // rows; that happens below via the framework's own pagination.
        const numBuckets = getNumBuckets(savedSearchId, bucketSize);
        log.audit({
            title: 'Computed bucket count',
            details: `savedSearchId=${savedSearchId}, bucketSize=${bucketSize}, numBuckets=${numBuckets}`
        });

        const loadedSearch = search.load({ id: savedSearchId });

        // Returning the search object lets the M/R framework handle
        // pagination/governance for the row-by-row read.
        return loadedSearch;
    }

    // Gets SKU, shipNode (derived from inventory location ID), and quantity for each row.
    function map(context) {
        const { savedSearchId, bucketSize, shipNodeMap } = getScriptParams();
        const numBuckets = getNumBuckets(savedSearchId, bucketSize);
        const result = JSON.parse(context.value);
        const values = result.values;

        const sku = getColumnValue(values, COLUMNS.SKU);
        if (!sku) {
            log.error({ title: 'Skipping row with blank SKU', details: `internal id ${result.id}` });
            return;
        }

        const locationId = getColumnId(values, COLUMNS.LOCATION);
        const shipNode = shipNodeMap[locationId];
        if (!shipNode) {
            // Not thrown -- one location missing from the map shouldn't
            // block every other SKU/location in this run. Surfaced in the
            // M/R error log for someone to fix the map param.
            log.error({
                title: 'Skipping row with unmapped Location',
                details: `sku=${sku}, locationId=${locationId} has no entry in ${PARAMS.SHIP_NODE_MAP}`
            });
            return;
        }

        const amount = parseInt(getColumnValue(values, COLUMNS.QUANTITY_AVAILABLE), 10) || 0;
        const internalId = parseInt(result.id, 10);
        const bucket = internalId % numBuckets;

        context.write({
            key: String(bucket),
            value: JSON.stringify({ sku, shipNode, amount })
        });
    }

    function reduce(context) {
        const { clientId, clientSecret, environment } = getScriptParams();
        if (!clientId || !clientSecret) {
            throw new Error('Missing Walmart API credentials script parameters.');
        }

        const baseUrl = getBaseUrl(environment);

        // { sku, shipNode, amount }
        const rows = context.values.map((v) => JSON.parse(v));

        // { sku, shipNodes: [{ shipNode, amount }, { shipNode, amount }]}
        const bySku = new Map();
        for (const { sku, shipNode, amount } of rows) {
            if (!bySku.has(sku)) {
                bySku.set(sku, []);
            }
            bySku.get(sku).push({
                shipNode,
                amount
            });
        }

        const items = Array.from(bySku.entries()).map(([sku, shipNodes]) => ({ sku, shipNodes }));
        const skuQuantities = JSON.stringify(items);

        let correlationId = random.generateUUID();
        const accessToken = getAccessToken({ clientId, clientSecret, baseUrl, correlationId});
        
        correlationId = random.generateUUID();

        let feedId;
        try {
            feedId = submitInventoryFeed({ accessToken, baseUrl, items, correlationId });
        } catch (error) {
            const errorStatus = error.responseCode === 429 ? FEED_STATUS.RATE_LIMITED : FEED_STATUS.ERROR;
            recordFailedFeedSubmission({
                bucket: context.key,
                itemCount: items.length,
                environment,
                correlationId,
                skuQuantities,
                status: errorStatus,
                errorMessage: error.message
            })
            throw error;
        }

        recordFeedSubmission({
            feedId,
            bucket: context.key,
            itemCount: items.length,
            environment,
            correlationId,
            skuQuantities
        });

        log.audit({
            title: `Bucket ${context.key} submitted`,
            details: `feedId=${feedId}, itemCount=${items.length}`
        });

        context.write({
            key: context.key,
            value: feedId
        });
    }

    function summarize(summary) {
        let mapErrors = 0;
        let reduceErrors = 0;

        summary.mapSummary.errors.iterator().each((key, error) => {
            mapErrors++;
            log.error({ title: `Map error (key ${key})`, details: error });
            return true;
        });

        summary.reduceSummary.errors.iterator().each((key, error) => {
            reduceErrors++;
            log.error({ title: `Reduce error (bucket ${key})`, details: error });
            return true;
        });

        const feedIds = [];
        summary.output.iterator().each((key, value) => {
            feedIds.push(value);
            return true;
        });

        log.audit({
            title: 'Walmart multi-node inventory feed upload summary',
            details: `feeds submitted=${feedIds.length}, mapErrors=${mapErrors}, reduceErrors=${reduceErrors}, feedIds=${feedIds.join(', ')}`
        });
    }

    return { 
        getInputData, 
        map, 
        reduce, 
        summarize 
    };
})