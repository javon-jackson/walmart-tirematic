/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Bulk BASE price push via Walmart's asynchronous LEGACY price feed
 * (feedType=price -- "Update bulk prices (Legacy)", multipart/form-data,
 * `PriceHeader`/`Price` envelope).
 *
 * Pulls SKU + Base Price from a NetSuite saved search, batches each
 * reduce() bucket's items into one feed file, and submits via
 * POST /v3/feeds?feedType=price. Processing is asynchronous (minutes to
 * hours) -- tracked the same way as every other feed type in this project:
 * writes to the SHARED customrecord_wal_feed_submission record
 * (FEED_TYPE="price" distinguishes these rows from "inventory"/"MP_ITEM"),
 * for wm_sl_feed_status.js to check status on later.
 *
 * Per Walmart's docs: wait at least 5 minutes after submission before
 * checking status -- per-SKU results aren't available until the ENTIRE feed
 * finishes processing (checking too early just shows RECEIVED/INPROGRESS).
 * Also per Walmart: submitting the same SKU more than once in one feed
 * errors that SKU -- reduce() below de-dupes by SKU before building the
 * payload (keeping the last value seen) as a defensive guard, even though a
 * plain Item saved search shouldn't normally produce duplicate rows for the
 * same item.
 *
 * RATE LIMIT: POST /v3/feeds?feedType=price
 * (Legacy) is limited to 10 requests/hour, same as the other feed types in
 * this project. Bucket COUNT is capped at MAX_BUCKETS_PER_HOUR (10) so a
 * single run never attempts more submissions than Walmart allows -- a
 * catalog spike just produces fewer, larger buckets instead. A submission
 * that still 429s anyway (e.g. another script or a manual resubmit used up
 * the hour's quota first) is logged as a reduce error, not silently lost.
 *
 * Also per that doc: this API shouldn't be called sooner than 24 hours
 * after a new item is set up (before Walmart has assigned it a wpid) -- not
 * enforced in code, just worth knowing if a freshly-uploaded item's price
 * push comes back with an error.
 *
 * Currency is hardcoded to USD and currentPriceType to "BASE".
 *
 * Script parameters:
 *   custscript_wal_price_feed_saved_search  - internal ID of a saved search
 *                                             on Item with SKU + Base Price
 *                                             columns (same "pricing.unitprice"
 *                                             column label wm_mr_tire_upload.js
 *                                             uses for price)
 *   custscript_wal_price_feed_client_id     - Walmart Marketplace API Client ID
 *   custscript_wal_price_feed_client_secret - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_price_feed_env           - "PRODUCTION" or "SANDBOX"
 *   custscript_wal_price_feed_bucket_size   - TARGET items per bucket (default 1000, Walmart's
 *                                             recommended max -- see the tradeoff note above about
 *                                             hashing not giving a hard per-bucket guarantee) -- NOT
 *                                             a bucket count; getNumBuckets() below divides the saved
 *                                             search's total row count by this to compute how many
 *                                             buckets to hash into, so it doesn't need re-tuning as
 *                                             the catalog grows the way a fixed bucket count would
 *
 */
define(['N/search', 'N/runtime', 'N/log', 'N/https', 'N/encode', 'N/record', 'N/crypto/random', 'N/cache'], (search, runtime, log, https, encode, record, random, cache) => {

    const BASE_URLS = {
        PRODUCTION: 'https://marketplace.walmartapis.com',
        SANDBOX: 'https://sandbox.walmartapis.com'
    };


    const COLUMNS = {
        SKU: 'itemid',
        PRICE: 'unitprice.pricing' // Price Level MPM
    };

    const CURRENCY = 'USD';
    const PRICE_TYPE = 'BASE';

    // https://developer.walmart.com/us-marketplace/reference/pricebulkuploads
    // Download sample body.
    const PRICE_HEADER_VERSION = '1.7';

    const 
    FEED_TYPE = 'price';
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
            // JSON array of {sku, amount}
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
     * list/record joins. Same helper as the other scripts in this project.
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

    // Covers one full run of this M/R job (low-hundreds-to-low-thousands SKU
    // catalog) without recomputing the bucket count on every map() call.
    const BUCKET_CACHE_TTL_SECONDS = 3600;
    const BUCKET_CACHE_NAME = 'wal_bulk_price_feed_buckets';

    // POST /v3/feeds?feedType=price is limited to 10 requests/hour,
    // one feed submission per bucket, so the bucket count
    // itself must never exceed this.
    const MAX_BUCKETS_PER_HOUR = 10;

    /**
     * Computes (and caches) how many buckets to hash items across, via a
     * CHEAP count-only query -- search.runPaged().count returns just the row
     * count, not the rows, avoiding the governance cost of an earlier
     * version that materialized the whole catalog (reverted -- see
     * [[pricing_management_started]] in memory for why). Cached via N/cache
     * so map() isn't re-running a search for this number on every row:
     * getInputData() populates it once via the loader below; if the entry
     * expires mid-run, a later map() call just recomputes it rather than
     * failing. Keyed by savedSearchId + bucketSize so a stale value from a
     * different search/bucket-size combo is never reused.
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
                const uncapped = Math.max(1, Math.ceil(totalCount / bucketSize));
                const computed = Math.min(MAX_BUCKETS_PER_HOUR, uncapped);
                log.audit({
                    title: 'Computed bucket count',
                    details: `savedSearchId=${savedSearchId}, totalCount=${totalCount}, bucketSize=${bucketSize}, numBuckets=${computed}`
                        + (computed < uncapped ? ` (capped from ${uncapped} -- raise custscript_wal_price_feed_bucket_size if buckets are getting too large)` : '')
                });
                return String(computed);
            }
        });
        return parseInt(value, 10);
    }

    // ---------------------------------------------------------------------
    // Walmart Marketplace Legacy Price Feed API client
    // Docs: https://developer.walmart.com/us-marketplace/reference/tokenapi
    //       https://developer.walmart.com/us-marketplace/reference/pricebulkuploads
    // ---------------------------------------------------------------------

    /** Same OAuth client-credentials flow as every other script in this project. */
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
     * Wraps a batch of {sku, amount} pairs in the legacy price feed
     * envelope -- one `pricing` entry per SKU, same currentPrice/
     * currentPriceType shape as wm_sl_base_price_lkup_update.js's
     * updatePrice() (PUT /v3/price).
     * @param {{sku: string, amount: number}[]} items
     * @returns {string} JSON string ready to embed in the multipart body
     */
    function buildFeedPayload(items) {
        return JSON.stringify({
            PriceHeader: { version: PRICE_HEADER_VERSION },
            Price: items.map(({ sku, amount }) => ({
                sku,
                pricing: [{
                    currentPrice: { currency: CURRENCY, amount },
                    currentPriceType: PRICE_TYPE
                }]
            }))
        });
    }

    /**
     * Hand-builds a multipart/form-data body containing a single "file"
     * part.
     * @param {string} fileContent - the feed JSON string
     * @param {string} boundary
     * @returns {string}
     */
    function buildMultipartBody(fileContent, boundary) {
        const CRLF = '\r\n';
        return `--${boundary}${CRLF}`
            + `Content-Disposition: form-data; name="file"; filename="price-feed.json"${CRLF}`
            + `Content-Type: application/json${CRLF}`
            + CRLF
            + fileContent + CRLF
            + `--${boundary}--${CRLF}`;
    }

    /**
     * Submits a batch of items as a legacy price feed via
     * POST /v3/feeds?feedType=price (multipart/form-data).
     * @param {Object} params
     * @param {string} params.accessToken
     * @param {string} params.baseUrl
     * @param {{sku: string, amount: number}[]} params.items
     * @param {string} params.correlationId
     * @returns {string} feedId
     */
    function submitPriceFeed(params) {
        const { accessToken, baseUrl, items, correlationId } = params;

        const feedJson = buildFeedPayload(items);
        const boundary = `----WalmartPriceFeedBoundary${random.generateUUID().replace(/-/g, '')}`;
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
            const error = new Error(`Walmart price feed submission failed (${response.code}): ${response.body}`);
            error.responseCode = response.code;
            throw error;
        }

        const parsed = JSON.parse(response.body);
        log.audit({ title: 'Walmart price feed submitted', details: parsed.feedId });
        return parsed.feedId;
    }

    /**
     * Persists one row per submitted feed so wm_sl_feed_status.js (or a
     * future polling script) can find it and check status later. Logged but
     * not thrown on failure -- a tracking-record failure shouldn't fail the
     * feed submission itself; Walmart has already accepted the feed by this
     * point.
     * @param {string} params.skuPrices - JSON string of {sku, amount}[] -- see FEED_RECORD.FIELDS.SKUS above
     */
    function recordFeedSubmission(params) {
        const { feedId, bucket, itemCount, environment, correlationId, skuPrices } = params;
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
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.SKUS, value: skuPrices });
            rec.save();
        } catch (e) {
            log.error({ title: `Failed to record feed submission tracking (feedId=${feedId})`, details: e });
        }
    }

    /**
     * Persists one row for a bucket that FAILED to submit at all (no feedId
     * was ever issued by Walmart) -- e.g. a 429 rate-limit or any other
     * non-200 response.
     * @param {string} params.skuPrices - JSON string of {sku, amount}[] -- see FEED_RECORD.FIELDS.SKUS above
     * @param {string} params.status - FEED_STATUS.ERROR or FEED_STATUS.RATE_LIMITED
     * @param {string} params.errorMessage
     */
    function recordFailedFeedSubmission(params) {
        const { bucket, itemCount, environment, correlationId, skuPrices, status, errorMessage } = params;
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
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.SKUS, value: skuPrices });
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
            savedSearchId: script.getParameter({ name: 'custscript_wal_price_feed_saved_search' }),
            clientId: script.getParameter({ name: 'custscript_wal_price_feed_client_id' }),
            clientSecret: script.getParameter({ name: 'custscript_wal_price_feed_client_secret' }),
            environment: script.getParameter({ name: 'custscript_wal_price_feed_env' }) || 'SANDBOX',
            bucketSize: parseInt(script.getParameter({ name: 'custscript_wal_price_feed_bucket_size' }), 10) || 1000
        };
    }

    function getBaseUrl(environment) {
        return environment === 'PRODUCTION' ? BASE_URLS.PRODUCTION : BASE_URLS.SANDBOX;
    }

    const getInputData = () => {
        const { savedSearchId, bucketSize } = getScriptParams();
        if (!savedSearchId) {
            throw new Error('Missing required script parameter: custscript_wal_price_feed_saved_search');
        }

        // Populates the bucket-count cache up front (see getNumBuckets())
        // so it's ready before map() needs it -- doesn't load the actual
        // rows; that happens below via the framework's own pagination.
        getNumBuckets(savedSearchId, bucketSize);

        // Search object as-is lets the M/R framework handle pagination/governance.
        return search.load({ id: savedSearchId });
    };

    const map = (context) => {
        const { savedSearchId, bucketSize } = getScriptParams();
        const numBuckets = getNumBuckets(savedSearchId, bucketSize);
        const result = JSON.parse(context.value);
        const values = result.values;

        const sku = getColumnValue(values, COLUMNS.SKU);

        const amount = parseFloat(getColumnValue(values, COLUMNS.PRICE)) || 0;

        if (!sku) {
            log.error({ title: 'Skipping row with blank SKU', details: `internal id ${result.id} sku: ${sku} amt: ${amount}` });
            return;
        }
        if (!amount) {
            log.error({ title: 'Skipping row with blank/zero price', details: `sku ${sku} (internal id ${result.id}) amt:${amount}` });
            return;
        }

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

        const rawItems = context.values.map((v) => JSON.parse(v));

        // TODO: docs don't say if this dupe-SKU-errors behavior is specific
        // to price feeds or applies to all feed types.
        // De-dupe by SKU before building the payload, keeping the last
        // value seen (Walmart errors on any SKU submitted twice in one feed
        // -- see file header). Defensive, not an expected case, since a
        // plain Item saved search shouldn't produce duplicate rows for the
        // same item; logged when it happens so it's visible why a SKU's
        // price differs from what a given row showed.
        const bySku = new Map();
        rawItems.forEach((item) => {
            if (bySku.has(item.sku)) {
                log.audit({
                    title: `Duplicate SKU in bucket ${context.key} -- keeping last value`,
                    details: `sku=${item.sku}, discarded amount=${bySku.get(item.sku).amount}, kept amount=${item.amount}`
                });
            }
            bySku.set(item.sku, item);
        });
        const items = Array.from(bySku.values());

        const skuPrices = JSON.stringify(items);

        // Each Walmart call gets its own correlation ID.
        let correlationId = random.generateUUID();
        const accessToken = getAccessToken({ clientId, clientSecret, baseUrl, correlationId });

        correlationId = random.generateUUID();
        
        let feedId;
        try {
            feedId = submitPriceFeed({ accessToken, baseUrl, items, correlationId });
        } catch (e) {
            const status = e.responseCode === 429 ? FEED_STATUS.RATE_LIMITED : FEED_STATUS.ERROR;
            recordFailedFeedSubmission({
                bucket: context.key,
                itemCount: items.length,
                environment,
                correlationId,
                skuPrices,
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
            skuPrices
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
            title: 'Walmart price feed upload summary',
            details: `feeds submitted=${feedIds.length}, mapErrors=${mapErrors}, reduceErrors=${reduceErrors}, feedIds=${feedIds.join(', ')}`
        });
    };

    return { getInputData, map, reduce, summarize };
});
