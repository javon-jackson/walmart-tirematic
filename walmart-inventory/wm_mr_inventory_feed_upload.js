/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Bulk inventory push via Walmart's asynchronous inventory FEED.
 * Pulls SKU + Quantity Available from a NetSuite saved
 * search, batches each reduce() bucket into one feed file, and submits via
 * POST /v3/feeds?feedType=inventory.
 *
 * Uses spec 1.4 (single ship node, flat `quantity` object) rather than
 * spec 1.5/MP_INVENTORY (multiple ship nodes per SKU) to match this
 * project's existing single-ship-node/single-location assumption (see
 * README Known gaps) -- switch to 1.5 if per-ship-node control is needed.
 *
 * IMPORTANT -- this endpoint accepts **multipart/form-data ONLY**
 *
 * Feed processing is asynchronous (minutes to hours), so each feed's ID
 * is persisted to a tracking custom record for wm_sl_feed_status.js (or a
 * future poller) to check later.
 * 
 * Script parameters:
 *   custscript_wal_inv_feed_saved_search_id  - internal ID of a saved search
 *                                              on Item with SKU + Quantity
 *                                              Available columns (same
 *                                              search wm_mr_inventory_reconciliation.js uses)
 *   custscript_wal_inv_feed_client_id        - Walmart Marketplace API Client ID
 *   custscript_wal_inv_feed_client_secret    - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_inv_feed_env              - "PRODUCTION" or "SANDBOX"
 *   custscript_wal_inv_feed_bucket_size      - TARGET items per bucket (default 1000, matching
 *                                              wm_mr_price_feed_upload.js/wm_mr_tire_upload.js for
 *                                              consistency -- this feed has no Walmart-documented
 *                                              item-count cap like those two, so 1000 isn't a
 *                                              confirmed Walmart number). NOT a bucket count --
 *                                              getNumBuckets() below divides the saved search's
 *                                              total row count by this (2026-08-06, replaced the
 *                                              old fixed custscript_wal_inv_feed_num_buckets) so it
 *                                              doesn't need re-tuning as the catalog grows
 *
 * LIMITS: file size under 10MB, and POST /v3/feeds?feedType=inventory
 * limited to 10 requests/hour. Bucket COUNT is auto-computed (see
 * getNumBuckets() below) rather than manually tuned, and is capped at
 * MAX_BUCKETS_PER_HOUR (10) so a single run never attempts more submissions
 * than Walmart allows -- a catalog spike just produces fewer, larger buckets
 * instead. A submission that still 429s anyway (e.g. another script or a
 * manual resubmit used up the hour's quota first) is recorded, not silently
 * lost -- see recordFailedFeedSubmission()/FEED_STATUS.RATE_LIMITED.
 *
 */
define(['N/search', 'N/runtime', 'N/log', 'N/https', 'N/encode', 'N/record', 'N/crypto/random', 'N/cache'], (search, runtime, log, https, encode, record, random, cache) => {

    const BASE_URLS = {
        PRODUCTION: 'https://marketplace.walmartapis.com',
        SANDBOX: 'https://sandbox.walmartapis.com'
    };

    // TODO: currently the saved search return tires in Tampa only.
    const COLUMNS = {
        SKU: 'itemid',
        QUANTITY_AVAILABLE: 'locationquantityavailable' // quantityavailable for all locations inventory.
    };

    const QUANTITY_UNIT = 'EACH';

    // https://developer.walmart.com/us-marketplace/docs/bulk-inventory
    // https://developer.walmart.com/us-marketplace/docs/download-schemas
    const INVENTORY_HEADER_VERSION = '1.4';

    const FEED_TYPE = 'inventory';
    const WALMART_ITEM_TYPE = 'Tires';

    // ---------------------------------------------------------------------
    // Feed tracking
    // ---------------------------------------------------------------------
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
            // This script stores a JSON array of {sku, amount} so the
            // quantity pushed per SKU is visible on the row without a
            // separate per-SKU tracking record.
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

    /**
     * Reads a value out of a search-result `values` object, handling both
     * plain values and the {value, text} shape NetSuite returns for
     * list/record joins.
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

    // Covers one full M/R run (low-hundreds-to-low-thousands SKU catalog)
    // without recomputing the bucket count on every map() call -- 1 hour.
    const BUCKET_CACHE_TTL_SECONDS = 3600;
    const BUCKET_CACHE_NAME = 'wal_inv_feed_buckets';

    // POST /v3/feeds?feedType=inventory is limited to 10 requests/hour, 
    // one feed submission per bucket, so the bucket count
    // itself must never exceed this.
    const MAX_BUCKETS_PER_HOUR = 10;

    /**
     * Computes (and caches) how many buckets to hash items across, from a
     * cheap count-only query -- search.runPaged().count returns just the
     * total row count, not the rows, avoiding the governance cost of
     * materializing the whole catalog. Cached via N/cache so map() isn't
     * re-running the search per row: getInputData() populates it once; if
     * the entry expires mid-run, a later map() call just recomputes it.
     * Keyed by savedSearchId + bucketSize so a stale value from a
     * different combo is never reused.
     * @param {string} savedSearchId
     * @param {number} bucketSize - target items per bucket
     * @returns {number}
     */
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
                            + 'custscript_wal_inv_feed_bucket_size if buckets are getting too large.'
                    });
                }
                return String(computed);
            }
        });
        return parseInt(value, 10);
    }

    // ---------------------------------------------------------------------
    // Walmart Marketplace Inventory Feed API client
    // Docs: https://developer.walmart.com/us-marketplace/reference/tokenapi
    //       https://developer.walmart.com/us-marketplace/reference/post_v3-feeds
    //       https://developer.walmart.com/us-marketplace/docs/bulk-inventory
    // ---------------------------------------------------------------------

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

    /**
     * Wraps a batch of {sku, amount} pairs in the spec 1.4 inventory feed
     * envelope.
     * @param {{sku: string, amount: number}[]} items
     * @returns {string} JSON string ready to embed in the multipart body
     */
    function buildFeedPayload(items) {
        return JSON.stringify({
            InventoryHeader: { version: INVENTORY_HEADER_VERSION },
            Inventory: items.map(({ sku, amount }) => ({
                sku,
                quantity: { unit: QUANTITY_UNIT, amount }
            }))
        });
    }

    /**
     * Hand-builds a multipart/form-data body with a single "file" part.
     * @param {string} fileContent - the feed JSON string
     * @param {string} boundary
     * @returns {string}
     */
    function buildMultipartBody(fileContent, boundary) {
        const CRLF = '\r\n';
        return `--${boundary}${CRLF}`
            + `Content-Disposition: form-data; name="file"; filename="inventory-feed.json"${CRLF}`
            + `Content-Type: application/json${CRLF}`
            + CRLF
            + fileContent + CRLF
            + `--${boundary}--${CRLF}`;
    }

    /**
     * ---------DEBUGGING FUNCTION---------
     * Pulls every Content-Disposition "name" out of a built multipart body
     * so the field name(s) being sent can be logged and checked at a glance
     * (e.g. confirming "file" is present) without eyeball-parsing the raw
     * multipart dump.
     * @param {string} body
     * @returns {string[]}
     */
    function extractMultipartFieldNames(body) {
        const matches = body.match(/Content-Disposition: form-data; name="[^"]+"/g) || [];
        return matches.map((m) => m.match(/name="([^"]+)"/)[1]);
    }

    /**
     * Submits a batch of items as a spec 1.4 inventory feed via
     * POST /v3/feeds?feedType=inventory (multipart/form-data).
     * @param {Object} params
     * @param {string} params.accessToken
     * @param {string} params.baseUrl
     * @param {{sku: string, amount: number}[]} params.items
     * @param {string} params.correlationId
     * @returns {string} feedId
     */
    function submitInventoryFeed(params) {
        const { accessToken, baseUrl, items, correlationId } = params;

        const feedJson = buildFeedPayload(items);
        const boundary = `----WalmartInventoryFeedBoundary${random.generateUUID().replace(/-/g, '')}`;
        const body = buildMultipartBody(feedJson, boundary);

        // log.debug({
        //     title: `Multipart request body about to be sent (correlationId=${correlationId})`,
        //     details: body
        // });
        // log.debug({
        //     title: `Multipart field name(s) in this request (correlationId=${correlationId})`,
        //     details: extractMultipartFieldNames(body).join(', ')
        // });

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
            const error = new Error(`Walmart inventory feed submission failed (${response.code}): ${response.body}`);
            error.responseCode = response.code;
            throw error;
        }

        const parsed = JSON.parse(response.body);
        log.audit({ title: 'Walmart inventory feed submitted', details: parsed.feedId });
        return parsed.feedId;
    }

    /**
     * Persists one row per submitted feed so wm_sl_feed_status.js (or a
     * future poller) can find and check it later. Logged, not thrown, on
     * failure -- Walmart has already accepted the feed by this point, so a
     * tracking-record failure shouldn't fail the submission itself.
     * @param {string} params.skuQuantities - JSON string of {sku, amount}[] -- see FEED_RECORD.FIELDS.SKUS above
     */
    function recordFeedSubmission(params) {
        const { feedId, bucket, itemCount, environment, correlationId, skuQuantities } = params;
        try {
            const rec = record.create({ type: FEED_RECORD.TYPE, isDynamic: false });
            rec.setValue({ fieldId: 'name', value: feedId });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.FEED_ID, value: feedId });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.STATUS, value: FEED_STATUS.RECEIVED });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.ENVIRONMENT, value: environment });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.ITEM_COUNT, value: itemCount });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.SUBMITTED_DATE, value: new Date() });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.BUCKET, value: bucket });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.CORRELATION_ID, value: correlationId });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.FEED_TYPE, value: FEED_TYPE });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.ITEM_TYPE, value: WALMART_ITEM_TYPE });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.SKUS, value: skuQuantities });
            rec.save();
        } catch (e) {
            log.error({ title: `Failed to record feed submission tracking (feedId=${feedId})`, details: e });
        }
    }

    /**
     * Persists one row for a bucket that FAILED to submit at all (no feedId
     * was ever issued by Walmart) -- e.g. a 429 rate-limit or any other
     * non-200 response.
     * @param {string} params.skuQuantities - JSON string of {sku, amount}[] -- see FEED_RECORD.FIELDS.SKUS above
     * @param {string} params.status - FEED_STATUS.ERROR or FEED_STATUS.RATE_LIMITED
     * @param {string} params.errorMessage
     */
    function recordFailedFeedSubmission(params) {
        const { bucket, itemCount, environment, correlationId, skuQuantities, status, errorMessage } = params;
        try {
            const rec = record.create({ type: FEED_RECORD.TYPE, isDynamic: false });
            rec.setValue({ fieldId: 'name', value: `${status}-bucket${bucket}-${correlationId}` });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.STATUS, value: status });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.ENVIRONMENT, value: environment });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.ITEM_COUNT, value: itemCount });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.SUBMITTED_DATE, value: new Date() });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.BUCKET, value: bucket });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.CORRELATION_ID, value: correlationId });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.FEED_TYPE, value: FEED_TYPE });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.ITEM_TYPE, value: WALMART_ITEM_TYPE });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.SKUS, value: skuQuantities });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.DETAILS, value: errorMessage });
            rec.save();
        } catch (e) {
            log.error({ title: `Failed to record FAILED feed submission tracking (bucket=${bucket}, status=${status})`, details: e });
        }
    }

    // ---------------------------------------------------------------------
    // Map/Reduce entry points
    // ---------------------------------------------------------------------
    function getScriptParams() {
        const script = runtime.getCurrentScript();
        return {
            savedSearchId: script.getParameter({ name: 'custscript_wal_inv_feed_saved_search_id' }),
            clientId: script.getParameter({ name: 'custscript_wal_inv_feed_client_id' }),
            clientSecret: script.getParameter({ name: 'custscript_wal_inv_feed_client_secret' }),
            environment: script.getParameter({ name: 'custscript_wal_inv_feed_env' }) || 'SANDBOX',
            bucketSize: parseInt(script.getParameter({ name: 'custscript_wal_inv_feed_bucket_size' }), 10) || 1000
        };
    }

    function getBaseUrl(environment) {
        return environment === 'PRODUCTION' ? BASE_URLS.PRODUCTION : BASE_URLS.SANDBOX;
    }

    const getInputData = () => {
        const { savedSearchId, bucketSize } = getScriptParams();
        if (!savedSearchId) {
            throw new Error('Missing required script parameter: custscript_wal_inv_feed_saved_search_id');
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
    };

    const map = (context) => {
        const { savedSearchId, bucketSize } = getScriptParams();
        const numBuckets = getNumBuckets(savedSearchId, bucketSize);
        const result = JSON.parse(context.value);
        const values = result.values;

        const sku = getColumnValue(values, COLUMNS.SKU);
        if (!sku) {
            log.error({ title: 'Skipping row with blank SKU', details: `internal id ${result.id}` });
            return;
        }

        const amount = parseInt(getColumnValue(values, COLUMNS.QUANTITY_AVAILABLE), 10) || 0;
        const internalId = parseInt(result.id, 10);
        const bucket = internalId % numBuckets;

        context.write({
            key: String(bucket),
            value: JSON.stringify({ sku, amount })
        });
    };

    const reduce = (context) => {
        const { clientId, clientSecret, environment } = getScriptParams();
        if (!clientId || !clientSecret) {
            throw new Error('Missing Walmart API credentials script parameters.');
        }

        const baseUrl = getBaseUrl(environment);

        const items = context.values.map((v) => JSON.parse(v));
        // {sku, amount}
        const skuQuantities = JSON.stringify(items);

        // Each Walmart call gets its own correlation ID rather than reusing
        // one across the token request and feed submission.
        let correlationId = random.generateUUID();
        const accessToken = getAccessToken({ clientId, clientSecret, baseUrl, correlationId });

        correlationId = random.generateUUID();
      
        let feedId;
        try {
            feedId = submitInventoryFeed({ accessToken, baseUrl, items, correlationId });
        } catch (e) {
            const status = e.responseCode === 429 ? FEED_STATUS.RATE_LIMITED : FEED_STATUS.ERROR;
            recordFailedFeedSubmission({
                bucket: context.key,
                itemCount: items.length,
                environment,
                correlationId,
                skuQuantities,
                status,
                errorMessage: e.message
            });
            throw e;
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

        context.write({ key: context.key, value: feedId });
    };

    const summarize = (summary) => {
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
            title: 'Walmart inventory feed upload summary',
            details: `feeds submitted=${feedIds.length}, mapErrors=${mapErrors}, reduceErrors=${reduceErrors}, feedIds=${feedIds.join(', ')}`
        });
    };

    return { getInputData, map, reduce, summarize };
});
