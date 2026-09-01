/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Bulk SKU-to-shipping-template mapping via Walmart's feedType = SKU_TEMPLATE_MAP.
 *
 * Each row's fulfillmentCenterId comes from LOCATION_FC_MAP (keyed by NetSuite
 * Location internal ID) and its shippingTemplateId comes from FC_TEMPLATE_MAP
 * (keyed by the resulting fulfillmentCenterId). A single saved search/deployment
 * therefore produces one fulfillmentCenterId+shippingTemplateId pair per Location --
 * if a subset of items at the same Location needs a different shippingTemplateId
 * (e.g. brand A vs brand B tires both shipping out of the same fulfillment center),
 * that split is handled by filtering the saved search to just that subset and giving
 * that deployment its own LOCATION_FC_MAP/FC_TEMPLATE_MAP param values.
 *
 *
 * Script parameters:
 *   custscript_wal_skutmpl_feed_saved_search    - internal ID of the saved search
 *                                                 described above (SKU + Location
 *                                                 columns; filter to a brand/subset
 *                                                 per deployment as needed)
 *   custscript_wal_skutmpl_feed_client_id       - Walmart Marketplace API Client ID
 *   custscript_wal_skutmpl_feed_client_secret   - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_skutmpl_feed_env             - "PRODUCTION" or "SANDBOX"
 *   custscript_wal_skutmpl_feed_bucket_size     - target items per bucket (default 1000,
 *                                                 same rationale as the other feed scripts)
 *   custscript_wal_skutmpl_feed_location_fc_map - JSON string mapping NetSuite Location
 *                                                 internal ID -> Walmart fulfillmentCenterId
 *                                                 (customNodeId), e.g.
 *                                                 {"1":"FC_TAMPA_01","4":"FC_DALLAS_01"}
 *   custscript_wal_skutmpl_feed_fc_template_map - JSON string mapping Walmart
 *                                                 fulfillmentCenterId -> shippingTemplateId,
 *                                                 e.g. {"FC_TAMPA_01":"TMPL_A"}
 *   custscript_wal_map_skus_max_items           - optional. Caps how many saved-search
 *                                                 rows are pulled in for this run (e.g.
 *                                                 30 for a bounded sandbox test). Blank/0
 *                                                 means no cap -- every row is processed.
 *
 */

define(['N/search', 'N/runtime', 'N/log', 'N/https', 'N/encode', 'N/record', 'N/crypto/random', 'N/cache'],
    (search, runtime, log, https, encode, record, random, cache) => {

    const BASE_URLS = {
        PRODUCTION: 'https://marketplace.walmartapis.com',
        SANDBOX: 'https://sandbox.walmartapis.com'
    };

    const COLUMNS = {
        SKU: 'itemid',
        LOCATION: 'inventorylocation'
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
            DETAILS: 'custrecord_wal_feed_details',
            CORRELATION_ID: 'custrecord_wal_feed_correlation_id',
            FEED_TYPE: 'custrecord_wal_feed_type',
            ITEM_TYPE: 'custrecord_wal_feed_item_type',
            // JSON array of {sku, fulfillmentCenterId, shippingTemplateId} so the
            // exact mapping pushed is visible on the row.
            SKUS: 'custrecord_wal_feed_skus'
        }
    };

    const FEED_STATUS = {
        RECEIVED: 'RECEIVED',
        ERROR: 'ERROR',
        RATE_LIMITED: 'RATE_LIMITED'
    };

    const PARAMS = {
        SAVED_SEARCH_ID: 'custscript_wal_map_skus_saved_search_id',
        CLIENT_ID: 'custscript_wal_map_skus_client_id',
        CLIENT_SECRET: 'custscript_wal_map_skus_client_secret',
        ENVIRONMENT: 'custscript_wal_map_skus_env',
        BUCKET_SIZE: 'custscript_wal_map_skus_bucket_size',
        LOCATION_FC_MAP: 'custscript_wal_loc_fc_map',
        FC_TEMPLATE_MAP: 'custscript_wal_fc_shiptmpl_map',
        MAX_ITEMS: 'custscript_wal_map_skus_max_items'
    };

    const ACTION_TYPE_ADD = 'Add';
    const FEED_TYPE = 'SKU_TEMPLATE_MAP';
    const WALMART_ITEM_TYPE = 'Tires';

    // Covers one full M/R run (low-hundreds-to-low-thousands SKU catalog)
    // without recomputing the bucket count on every map() call -- 1 hour.
    const BUCKET_CACHE_TTL_SECONDS = 3600;
    const BUCKET_CACHE_NAME = 'wal_skutmpl_feed_buckets';

    // Rate limit
    const MAX_BUCKETS_PER_HOUR = 10;

    function getScriptParams() {
        const script = runtime.getCurrentScript();
        return {
            savedSearchId: script.getParameter({ name: PARAMS.SAVED_SEARCH_ID }),
            clientId: script.getParameter({ name: PARAMS.CLIENT_ID }),
            clientSecret: script.getParameter({ name: PARAMS.CLIENT_SECRET }),
            environment: (script.getParameter({ name: PARAMS.ENVIRONMENT }) || 'SANDBOX').toUpperCase(),
            bucketSize: parseInt(script.getParameter({ name: PARAMS.BUCKET_SIZE }), 10) || 1000,
            locationFcMap: parseJsonParam(PARAMS.LOCATION_FC_MAP, script.getParameter({ name: PARAMS.LOCATION_FC_MAP })),
            fcTemplateMap: parseJsonParam(PARAMS.FC_TEMPLATE_MAP, script.getParameter({ name: PARAMS.FC_TEMPLATE_MAP })),
            maxItems: parseInt(script.getParameter({ name: PARAMS.MAX_ITEMS }), 10) || 0
        };
    }

    function parseJsonParam(paramName, raw) {
        try {
            return raw ? JSON.parse(raw) : {};
        } catch (e) {
            throw new Error(`${paramName} is not valid JSON: ${e.message}`);
        }
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
            ItemFeedHeader: { sellingChannel: 'precisedelivery', locale: 'en', version: '1.0' },
            Item: items.map(({ sku, fulfillmentCenterId, shippingTemplateId }) => ({
                PreciseDelivery: { shippingTemplateId, fulfillmentCenterId, actionType: ACTION_TYPE_ADD, sku }
            }))
        });
    }

    function buildMultipartBody(feedJson, boundary) {
        const CRLF = '\r\n';
        return `--${boundary}${CRLF}`
            + `Content-Disposition: form-data; name="file"; filename="sku-template-map-feed.json"${CRLF}`
            + `Content-Type: application/json${CRLF}`
            + CRLF
            + feedJson + CRLF
            + `--${boundary}--${CRLF}`;
    }

    function submitSkuTemplateMapFeed(params) {
        const { accessToken, baseUrl, items, correlationId, environment } = params;

        const feedJson = buildFeedPayload(items);
        const boundary = `----WalmartSkuTemplateMapMrBoundary${random.generateUUID().replace(/-/g, '')}`;
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
            const error = new Error(`Walmart SKU_TEMPLATE_MAP feed submission failed (${response.code}): ${response.body}`);
            error.responseCode = response.code;
            throw error;
        }

        const parsed = JSON.parse(response.body);
        log.audit({ title: 'Walmart SKU_TEMPLATE_MAP feed submitted', details: parsed.feedId });
        return parsed.feedId;
    }

    function getNumBuckets(savedSearchId, bucketSize, maxItems) {
        const bucketCache = cache.getCache({ name: BUCKET_CACHE_NAME, scope: cache.Scope.PRIVATE });
        const value = bucketCache.get({
            key: `numBuckets_${savedSearchId}_${bucketSize}_${maxItems || 0}`,
            ttl: BUCKET_CACHE_TTL_SECONDS,
            loader: () => {
                const totalCount = search.load({ id: savedSearchId }).runPaged({ pageSize: 1000 }).count;
                const effectiveCount = maxItems ? Math.min(totalCount, maxItems) : totalCount;
                const computed = Math.min(MAX_BUCKETS_PER_HOUR, Math.max(1, Math.ceil(effectiveCount / bucketSize)));
                if (Math.ceil(effectiveCount / bucketSize) > MAX_BUCKETS_PER_HOUR) {
                    log.audit({
                        title: 'Bucket count capped at MAX_BUCKETS_PER_HOUR',
                        details: `savedSearchId=${savedSearchId}, effectiveCount=${effectiveCount}, bucketSize=${bucketSize}, `
                            + `uncapped=${Math.ceil(effectiveCount / bucketSize)}, capped=${computed}. Raise `
                            + `${PARAMS.BUCKET_SIZE} if buckets are getting too large.`
                    });
                }
                return String(computed);
            }
        });
        return parseInt(value, 10);
    }

    // Pulls at most maxItems rows from the saved search, in place of returning
    // the whole loaded search from getInputData(). Only handles maxItems <= 1000
    // (a single search.run().getRange() page) -- fine for a bounded test run;
    // extend with runPaged()-based pagination if a cap above 1000 is ever needed.
    function collectLimitedResults(savedSearchId, maxItems) {
        if (maxItems > 1000) {
            throw new Error(`${PARAMS.MAX_ITEMS}=${maxItems} exceeds the 1000-row single-page limit `
                + 'collectLimitedResults() supports -- reduce the cap or extend this function with pagination.');
        }
        return search.load({ id: savedSearchId }).run().getRange({ start: 0, end: maxItems });
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
        const { feedId, bucket, itemCount, environment, correlationId, skuMappings, status, errorMessage } = params;
        try {
            const submissionRecord = record.create({ type: FEED_RECORD.TYPE, isDynamic: false });
            submissionRecord.setValue({ fieldId: 'name', value: feedId || `${status}-bucket${bucket}-${correlationId}` });
            if (feedId) submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.FEED_ID, value: feedId });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.STATUS, value: status });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.ENVIRONMENT, value: environment });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.ITEM_COUNT, value: itemCount });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.SUBMITTED_DATE, value: new Date() });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.BUCKET, value: bucket });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.CORRELATION_ID, value: correlationId });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.FEED_TYPE, value: FEED_TYPE });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.ITEM_TYPE, value: WALMART_ITEM_TYPE });
            submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.SKUS, value: skuMappings });
            if (errorMessage) submissionRecord.setValue({ fieldId: FEED_RECORD.FIELDS.DETAILS, value: String(errorMessage).substring(0, 1000) });
            submissionRecord.save();
        } catch (error) {
            log.error({ title: `Failed to record feed submission tracking (feedId=${feedId}, bucket=${bucket})`, details: error });
        }
    }

    function getInputData() {
        const { savedSearchId, bucketSize, locationFcMap, fcTemplateMap, maxItems } = getScriptParams();

        if (!savedSearchId) {
            throw new Error(`Missing required script parameter: ${PARAMS.SAVED_SEARCH_ID}`);
        }

        if (!locationFcMap || Object.keys(locationFcMap).length === 0) {
            throw new Error(`Missing or empty ${PARAMS.LOCATION_FC_MAP} -- this must map every `
                + 'NetSuite Location covered by the saved search to a real Walmart fulfillmentCenterId before this script can run.');
        }

        if (!fcTemplateMap || Object.keys(fcTemplateMap).length === 0) {
            throw new Error(`Missing or empty ${PARAMS.FC_TEMPLATE_MAP} -- this must map every `
                + 'fulfillmentCenterId reachable via ' + PARAMS.LOCATION_FC_MAP + ' to a real Walmart shippingTemplateId.');
        }

        // Populates the bucket-count cache up front (see getNumBuckets())
        // so it's ready before map() needs it -- doesn't load the actual
        // rows; that happens below via the framework's own pagination.
        const numBuckets = getNumBuckets(savedSearchId, bucketSize, maxItems);
        log.audit({
            title: 'Computed bucket count',
            details: `savedSearchId=${savedSearchId}, bucketSize=${bucketSize}, maxItems=${maxItems || 'none'}, numBuckets=${numBuckets}`
        });

        if (maxItems) {
            log.audit({ title: 'Row cap in effect', details: `Only the first ${maxItems} saved-search row(s) will be processed.` });
            return collectLimitedResults(savedSearchId, maxItems);
        }

        return search.load({ id: savedSearchId });
    }

    // Gets SKU, fulfillmentCenterId (via LOCATION_FC_MAP), and shippingTemplateId
    // (via FC_TEMPLATE_MAP chained off that fulfillmentCenterId) for each row.
    function map(context) {
        const { savedSearchId, bucketSize, locationFcMap, fcTemplateMap, maxItems } = getScriptParams();
        const numBuckets = getNumBuckets(savedSearchId, bucketSize, maxItems);
        const result = JSON.parse(context.value);
        const values = result.values;

        const sku = getColumnValue(values, COLUMNS.SKU);
        if (!sku) {
            log.error({ title: 'Skipping row with blank SKU', details: `internal id ${result.id}` });
            return;
        }

        const locationId = getColumnId(values, COLUMNS.LOCATION);
        const fulfillmentCenterId = locationFcMap[locationId];
        if (!fulfillmentCenterId) {
            // Not thrown -- one location missing from the map shouldn't
            // block every other SKU/location in this run. Surfaced in the
            // M/R error log for someone to fix the map param.
            log.error({
                title: 'Skipping row with unmapped Location',
                details: `sku=${sku}, locationId=${locationId} has no entry in ${PARAMS.LOCATION_FC_MAP}`
            });
            return;
        }

        const shippingTemplateId = fcTemplateMap[fulfillmentCenterId];
        if (!shippingTemplateId) {
            log.error({
                title: 'Skipping row with unmapped fulfillmentCenterId',
                details: `sku=${sku}, fulfillmentCenterId=${fulfillmentCenterId} has no entry in ${PARAMS.FC_TEMPLATE_MAP}`
            });
            return;
        }

        const internalId = parseInt(result.id, 10);
        const bucket = internalId % numBuckets;

        context.write({
            key: String(bucket),
            value: JSON.stringify({ sku, fulfillmentCenterId, shippingTemplateId })
        });
    }

    function reduce(context) {
        const { clientId, clientSecret, environment } = getScriptParams();
        if (!clientId || !clientSecret) {
            throw new Error('Missing Walmart API credentials script parameters.');
        }

        const baseUrl = getBaseUrl(environment);

        // { sku, fulfillmentCenterId, shippingTemplateId } -- each row already
        // carries its own pair (map() resolved it per-row), so unlike the
        // inventory feed's reduce() there's no need to group by SKU first;
        // the Item feed schema supports a different fulfillmentCenterId/
        // shippingTemplateId per entry in the same submission.
        const items = context.values.map((v) => JSON.parse(v));
        const skuMappings = JSON.stringify(items);

        let correlationId = random.generateUUID();
        const accessToken = getAccessToken({ clientId, clientSecret, baseUrl, correlationId });

        correlationId = random.generateUUID();

        let feedId;
        try {
            feedId = submitSkuTemplateMapFeed({ accessToken, baseUrl, items, correlationId, environment });
        } catch (error) {
            const errorStatus = error.responseCode === 429 ? FEED_STATUS.RATE_LIMITED : FEED_STATUS.ERROR;
            recordFeedSubmission({
                bucket: context.key,
                itemCount: items.length,
                environment,
                correlationId,
                skuMappings,
                status: errorStatus,
                errorMessage: error.message
            });
            throw error;
        }

        recordFeedSubmission({
            feedId,
            bucket: context.key,
            itemCount: items.length,
            environment,
            correlationId,
            skuMappings,
            status: FEED_STATUS.RECEIVED
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
            title: 'Walmart SKU_TEMPLATE_MAP feed upload summary',
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
