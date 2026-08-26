/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * On-demand Walmart feed status lookup. Enter a feedId from
 * customrecord_wal_feed_submission (written by wm_mr_tire_upload.js,
 * wm_mr_inventory_feed_upload.js, or wm_mr_price_feed_upload.js) and this
 * checks GET /v3/feeds/{feedId} against Walmart, using whichever environment
 * THIS deployment's custscript_wal_feed_env is set to. Updates
 * the matching tracking record's status/details if one exists.
 *
 *
 * "Resubmit Failed Feed" action: for a tracking record whose last known
 * STATUS is ERROR, rebuilds and resubmits the feed from that record's own
 * ENVIRONMENT/FEED_TYPE/SKUS -- no NetSuite lookup needed. Only works for
 * FEED_TYPE "price"/"inventory", since SKUS there holds `{sku, amount}`
 * pairs (enough to rebuild the payload). "MP_ITEM" SKUS is just a
 * `|`-delimited list -- content resubmission needs the full per-item
 * payload, which isn't stored anywhere; re-run wm_mr_tire_upload.js instead
 * (optionally filtered to the failed SKUs). A successful resubmit writes a
 * NEW tracking record (RETRY_OF pointing at the original) rather than
 * overwriting the failed one, so history stays visible.
 *
 * Script parameters:
 *   custscript_wal_feed_client_id       - Walmart Marketplace API Client ID
 *   custscript_wal_feed_client_secret   - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_feed_env             - "PRODUCTION" or "SANDBOX", fixed per deployment
 *
 * customrecord_wal_feed_submission carries
 * custrecord_wal_feed_retry_origin_record (Free-Form Text) for this --
 * stores the original failed record's internal ID, plain text rather than a
 * self-join, same convention as this project's other cross-references.
 */
define(
    ['N/ui/serverWidget', 'N/record', 'N/runtime', 'N/https', 'N/encode', 'N/search', 'N/log', 'N/crypto/random'],
    (serverWidget, record, runtime, https, encode, search, log, random) => {

        const BASE_URLS = {
            PRODUCTION: 'https://marketplace.walmartapis.com',
            SANDBOX: 'https://sandbox.walmartapis.com'
        };

        const FEED_RECORD = {
            TYPE: 'customrecord_wal_feed_submission',
            FIELDS: {
                FEED_ID: 'custrecord_wal_feed_id',
                STATUS: 'custrecord_wal_feed_status',
                ENVIRONMENT: 'custrecord_wal_feed_env',
                ITEM_COUNT: 'custrecord_wal_feed_item_count',
                SUBMITTED_DATE: 'custrecord_wal_feed_submitted_date',
                LAST_CHECKED_DATE: 'custrecord_wal_feed_last_checked',
                DETAILS: 'custrecord_wal_feed_details',
                CORRELATION_ID: 'custrecord_wal_feed_correlation_id',
                FEED_TYPE: 'custrecord_wal_feed_type',
                ITEM_TYPE: 'custrecord_wal_feed_item_type',
                SKUS: 'custrecord_wal_feed_skus',
                RETRY_OF: 'custrecord_wal_feed_retry_origin_record'
            }
        };

        // Resubmittable feed envelopes, duplicated from
        // Only works for FEED_TYPE "price"/"inventory", 
        // since SKUS there holds `{sku, amount}` pairs (enough to rebuild the payload)
        const CURRENCY = 'USD';
        const PRICE_TYPE = 'BASE';
        const PRICE_HEADER_VERSION = '1.7';
        const QUANTITY_UNIT = 'EACH';
        const INVENTORY_HEADER_VERSION = '1.4';
        const WALMART_ITEM_TYPE = 'Tires';

        /**
         * JSON.parse that logs the raw body before throwing, so a non-JSON
         * response (HTML error page, empty body, etc.) shows up in the
         * execution log instead of just an opaque "Unexpected token" message.
         */
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

        /** Logs code/headers/body for every Walmart call so nothing is left only on-screen or silently dropped. */
        function logHttpResponse(title, response, correlationId) {
            log[response.code === 200 ? 'audit' : 'error']({
                title: `${title} (correlationId=${correlationId})`,
                details: JSON.stringify({ code: response.code, headers: response.headers, body: response.body })
            });
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

        function getFeedStatus(params) {
            const { accessToken, baseUrl, feedId, correlationId, environment } = params;

            const url = `${baseUrl}/v3/feeds/${encodeURIComponent(feedId)}?includeDetails=true&limit=50&offset=0`;
            log.audit({ title: `Walmart feed status request (correlationId=${correlationId})`, details: url });

            const response = https.get({
                url,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_QOS.CORRELATION_ID': correlationId,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'Accept': 'application/json',
                    // TODO: with the 2 headers below, status checks return PROCESSED
                    // but always the same wrong feedId; without them, ERROR but the
                    // correct feedId. Possibly mismatched global/US-sandbox canned
                    // responses -- unresolved.
                    // 'WM_MARKET': 'us',
                    // 'WM_GLOBAL_VERSION': '3.1'
                }
            });

            logHttpResponse(`Walmart feed status response (feedId=${feedId})`, response, correlationId);
            if (response.code !== 200) {
                throw new Error(`Walmart feed status check failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }
            const parsed = safeJsonParse(response.body, correlationId, 'feed status');

            // itemsReceived: 0 with feedStatus ERROR/empty itemIngestionStatus means the
            // feed was rejected before any item was even parsed -- there's no item-level
            // error to surface, so flag it explicitly rather than letting it look like a
            // per-item validation failure buried in itemIngestionStatus.
            const noItemsTouched = !parsed.itemsReceived && !parsed.itemsSucceeded
                && !parsed.itemsFailed && !parsed.itemsProcessing;
            const noItemDetails = !parsed.itemDetails || !parsed.itemDetails.itemIngestionStatus
                || parsed.itemDetails.itemIngestionStatus.length === 0;
            if (parsed.feedStatus === 'ERROR' && noItemsTouched && noItemDetails) {
                log.error({
                    title: `Feed-level rejection, no item-level detail available (feedId=${feedId}, correlationId=${correlationId})`,
                    details: 'feedStatus is ERROR but itemsReceived/itemsFailed/itemsProcessing are all 0 and '
                        + 'itemIngestionStatus is empty -- Walmart rejected the feed before parsing any items, so '
                        + 'there is no per-item error message to find. This correlationId is what Walmart support '
                        + 'would need to look up what happened server-side.'
                });
            }

            return parsed;
        }

        function getScriptParams() {
            const script = runtime.getCurrentScript();
            return {
                clientId: script.getParameter({ name: 'custscript_wal_feed_client_id' }),
                clientSecret: script.getParameter({ name: 'custscript_wal_feed_client_secret' }),
                defaultEnvironment: script.getParameter({ name: 'custscript_wal_feed_env' }) || 'SANDBOX'
            };
        }

        function getBaseUrl(environment) {
            return environment === 'PRODUCTION' ? BASE_URLS.PRODUCTION : BASE_URLS.SANDBOX;
        }

        /** @returns {string|null} internal ID of the tracking record for this feedId, if any exists. */
        function findFeedRecordId(feedId) {
            const resultSet = search.create({
                type: FEED_RECORD.TYPE,
                filters: [[FEED_RECORD.FIELDS.FEED_ID, 'is', feedId]],
                columns: ['internalid']
            }).run().getRange({ start: 0, end: 1 });
            return resultSet.length ? resultSet[0].id : null;
        }

        /**
         * Updates the tracking record with the latest status check. Stores
         * Walmart's feedStatus as-is (confirmed enum: RECEIVED/INPROGRESS/
         * PROCESSED/ERROR), not remapped to a separate enum of our own.
         * Leaves CORRELATION_ID untouched -- that holds the original
         * submission's ID (what Walmart support needs to trace the feed back
         * to its creation), not this check's own ID, which is already
         * surfaced on-screen/logged at check time.
         */
        function updateFeedRecord(recordId, parsedStatus) {
            const rec = record.load({ type: FEED_RECORD.TYPE, id: recordId, isDynamic: false });
            if (parsedStatus.feedStatus) {
                rec.setValue({ fieldId: FEED_RECORD.FIELDS.STATUS, value: parsedStatus.feedStatus });
            }
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.DETAILS, value: JSON.stringify(parsedStatus) });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.LAST_CHECKED_DATE, value: new Date() });
            rec.save();
        }

        /**
         * Finds any existing tracking record(s) already retried from this one
         * (RETRY_OF = recordId) -- lets handleResubmit() warn instead of
         * silently creating a second/third resubmission of the same feed
         * when someone checks an old already-retried record's status and
         * hits Resubmit again.
         * @returns {{id: string, feedId: string, status: string}[]}
         */
        function findExistingRetries(recordId) {
            const resultSet = search.create({
                type: FEED_RECORD.TYPE,
                filters: [[FEED_RECORD.FIELDS.RETRY_OF, 'is', recordId]],
                columns: ['internalid', FEED_RECORD.FIELDS.FEED_ID, FEED_RECORD.FIELDS.STATUS]
            }).run().getRange({ start: 0, end: 50 });
            return resultSet.map((r) => ({
                id: r.id,
                feedId: r.getValue(FEED_RECORD.FIELDS.FEED_ID),
                status: r.getValue(FEED_RECORD.FIELDS.STATUS)
            }));
        }

        /** Reads the fields the Resubmit action needs off an existing tracking record. */
        function loadFeedRecordDetails(recordId) {
            const rec = record.load({ type: FEED_RECORD.TYPE, id: recordId, isDynamic: false });
            return {
                status: rec.getValue({ fieldId: FEED_RECORD.FIELDS.STATUS }),
                environment: rec.getValue({ fieldId: FEED_RECORD.FIELDS.ENVIRONMENT }),
                feedType: rec.getValue({ fieldId: FEED_RECORD.FIELDS.FEED_TYPE }),
                itemType: rec.getValue({ fieldId: FEED_RECORD.FIELDS.ITEM_TYPE }),
                skus: rec.getValue({ fieldId: FEED_RECORD.FIELDS.SKUS })
            };
        }

        /**
         * Builds the resubmit feed JSON, branching on FEED_TYPE -- same
         * envelopes as wm_mr_price_feed_upload.js/wm_mr_inventory_feed_upload.js.
         * Throws for any other feedType (see file header for why "MP_ITEM"
         * can't work this way).
         * @param {string} feedType - "price" or "inventory"
         * @param {{sku: string, amount: number}[]} items
         */
        function buildResubmitPayload(feedType, items) {
            if (feedType === 'price') {
                return {
                    json: JSON.stringify({
                        PriceHeader: { version: PRICE_HEADER_VERSION },
                        Price: items.map(({ sku, amount }) => ({
                            sku,
                            pricing: [{
                                currentPrice: { currency: CURRENCY, amount },
                                currentPriceType: PRICE_TYPE
                            }]
                        }))
                    }),
                    filename: 'price-feed.json',
                    boundaryPrefix: 'WalmartPriceFeedBoundary'
                };
            }
            if (feedType === 'inventory') {
                return {
                    json: JSON.stringify({
                        InventoryHeader: { version: INVENTORY_HEADER_VERSION },
                        Inventory: items.map(({ sku, amount }) => ({
                            sku,
                            quantity: { unit: QUANTITY_UNIT, amount }
                        }))
                    }),
                    filename: 'inventory-feed.json',
                    boundaryPrefix: 'WalmartInventoryFeedBoundary'
                };
            }
            throw new Error(`Resubmit isn't supported for feedType "${feedType}" -- only "price" and "inventory" `
                + 'feeds can be rebuilt from their tracking record alone. For an "MP_ITEM" content feed, re-run '
                + 'wm_mr_tire_upload.js instead (optionally filtered to just the failed SKUs).');
        }

        /**
         * Hand-builds a multipart/form-data body with one "file" part --
         * N/https has no native multipart helper, same approach as the
         * feed-upload M/R scripts. filename is parameterized since
         * price/inventory use different ones.
         */
        function buildMultipartBody(fileContent, boundary, filename) {
            const CRLF = '\r\n';
            return `--${boundary}${CRLF}`
                + `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}`
                + `Content-Type: application/json${CRLF}`
                + CRLF
                + fileContent + CRLF
                + `--${boundary}--${CRLF}`;
        }

        /**
         * Resubmits a price/inventory feed via POST /v3/feeds?feedType=...,
         * rebuilt from the tracking record's SKUS alone -- no saved search
         * involved.
         * @returns {string} the NEW feedId Walmart assigns to this resubmission
         */
        function submitResubmittedFeed(params) {
            const { accessToken, baseUrl, feedType, items, correlationId } = params;
            const { json, filename, boundaryPrefix } = buildResubmitPayload(feedType, items);
            const boundary = `----${boundaryPrefix}${random.generateUUID().replace(/-/g, '')}`;
            const body = buildMultipartBody(json, boundary, filename);

            const response = https.post({
                url: `${baseUrl}/v3/feeds?feedType=${feedType}`,
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

            logHttpResponse(`Walmart ${feedType} feed resubmission`, response, correlationId);
            if (response.code !== 200) {
                throw new Error(`Walmart ${feedType} feed resubmission failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }
            const parsed = safeJsonParse(response.body, correlationId, `${feedType} feed resubmission`);
            if (!parsed.feedId) {
                throw new Error(`Walmart ${feedType} feed resubmission response missing feedId (correlationId=${correlationId}): ${response.body}`);
            }
            return parsed.feedId;
        }

        /**
         * Writes a NEW tracking record for a resubmitted feed -- the original
         * failed record is left untouched so the failure stays visible in
         * history. RETRY_OF links back to it for traceability.
         */
        function recordRetrySubmission(params) {
            const { feedId, itemCount, environment, correlationId, skus, feedType, itemType, retryOfRecordId } = params;
            const rec = record.create({ type: FEED_RECORD.TYPE, isDynamic: false });
            rec.setValue({ fieldId: 'name', value: feedId });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.FEED_ID, value: feedId });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.STATUS, value: 'RECEIVED' });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.ENVIRONMENT, value: environment });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.ITEM_COUNT, value: itemCount });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.SUBMITTED_DATE, value: new Date() });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.CORRELATION_ID, value: correlationId });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.FEED_TYPE, value: feedType });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.ITEM_TYPE, value: itemType || WALMART_ITEM_TYPE });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.SKUS, value: skus });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.RETRY_OF, value: retryOfRecordId });
            return rec.save();
        }

        /**
         * @param {Object} params
         * @param {string} [params.feedId] - repopulates the form after a lookup
         * @param {string} [params.action] - 'check' or 'resubmit', repopulates the Action dropdown
         * @param {string} [params.resultText] - result/error message from the last lookup
         */
        function buildForm(params) {
            const form = serverWidget.createForm({
                title: `Walmart Feed Status Lookup (${getScriptParams().defaultEnvironment})`
            });

            const actionField = form.addField({
                id: 'custpage_action',
                type: serverWidget.FieldType.SELECT,
                label: 'Action'
            });
            actionField.addSelectOption({ value: 'check', text: 'Check Status' });
            actionField.addSelectOption({ value: 'resubmit', text: 'Resubmit Failed Feed' });
            actionField.defaultValue = params.action || 'check';

            const feedIdField = form.addField({
                id: 'custpage_feed_id',
                type: serverWidget.FieldType.TEXT,
                label: 'Feed ID'
            });
            feedIdField.isMandatory = true;
            feedIdField.setHelpText({
                help: 'For "Resubmit Failed Feed," this must be the Feed ID of a tracking record whose last '
                    + 'checked status is ERROR -- use "Check Status" first if you\'re not sure.'
            });
            if (params.feedId) feedIdField.defaultValue = params.feedId;

            const confirmReretryField = form.addField({
                id: 'custpage_confirm_reretry',
                type: serverWidget.FieldType.CHECKBOX,
                label: 'Resubmit anyway (this feed already has a prior retry)'
            });
            confirmReretryField.setHelpText({
                help: 'Only relevant to "Resubmit Failed Feed." Leave unchecked the first time -- if this feed was '
                    + 'already retried before, the result will list the existing retry/retries instead of '
                    + 'submitting another one. Check this box and submit again only if you deliberately want to '
                    + 'create another resubmission anyway.'
            });

            form.addSubmitButton({ label: 'Submit' });

            if (params.resultText) {
                const resultField = form.addField({
                    id: 'custpage_result',
                    type: serverWidget.FieldType.LONGTEXT,
                    label: 'Result'
                });
                resultField.defaultValue = params.resultText;
                resultField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
            }

            return form;
        }

        /** "Check Status" action -- extracted from onRequest so it can branch on Action. */
        function handleCheckStatus(params) {
            const { feedId, environment, clientId, clientSecret, baseUrl } = params;

            let resultText;
            // Reassigned before each Walmart call rather than a second ID, so
            // if the token request itself fails, the catch block still logs
            // the ID that request actually used.
            let correlationId = random.generateUUID();
            try {
                const accessToken = getAccessToken({ clientId, clientSecret, baseUrl, correlationId });
                correlationId = random.generateUUID();
                const status = getFeedStatus({ accessToken, baseUrl, feedId, correlationId, environment });
                resultText = `correlationId: ${correlationId} (reference this if you need to ask Walmart support about this feed)\n\n`
                    + JSON.stringify(status, null, 2);

                const noItemsTouched = !status.itemsReceived && !status.itemsSucceeded
                    && !status.itemsFailed && !status.itemsProcessing;
                const noItemDetails = !status.itemDetails || !status.itemDetails.itemIngestionStatus
                    || status.itemDetails.itemIngestionStatus.length === 0;
                if (status.feedStatus === 'ERROR' && noItemsTouched && noItemDetails) {
                    resultText += '\n\n*** feedStatus is ERROR but no items were ever received/processed and '
                        + 'itemIngestionStatus is empty -- Walmart rejected this feed before parsing any items, so '
                        + "there is no per-item error message here to find. This isn't a missing-field-on-one-item "
                        + 'problem; it points at the feed submission itself (envelope, auth, rate limit, etc). See '
                        + 'the execution log for the full request/response and use the correlationId above with '
                        + 'Walmart support if needed. ***';
                }

                const recordId = findFeedRecordId(feedId);
                if (recordId) {
                    updateFeedRecord(recordId, status);
                    resultText += `\n\n(Updated customrecord_wal_feed_submission #${recordId}.)`;
                    if (status.feedStatus === 'ERROR') {
                        resultText += '\n\nTo resubmit this feed (price/inventory feed types only), switch the '
                            + 'Action dropdown above to "Resubmit Failed Feed" and submit again with the same Feed ID.';
                    }
                } else {
                    resultText += '\n\n(No matching customrecord_wal_feed_submission found for this feed ID -- not saved.)';
                }
            } catch (e) {
                resultText = `Error: ${e.message}\n\ncorrelationId: ${correlationId}\n\nSee execution log for full request/response details.`;
                log.error({ title: `Feed status lookup failed (feedId=${feedId}, correlationId=${correlationId})`, details: e });
            }

            return resultText;
        }

        /**
         * "Resubmit Failed Feed" -- rebuilds and resubmits a price/inventory
         * feed from its tracking record's SKUS alone. Requires STATUS to
         * already be ERROR (run "Check Status" first) so a healthy feed
         * can't be resubmitted by accident.
         */
        function handleResubmit(params) {
            const { feedId, clientId, clientSecret, confirmReretry } = params;

            const recordId = findFeedRecordId(feedId);
            if (!recordId) {
                return `No customrecord_wal_feed_submission found for feed ID "${feedId}" -- nothing to resubmit from.`;
            }

            const details = loadFeedRecordDetails(recordId);
            if (details.status !== 'ERROR') {
                return `customrecord_wal_feed_submission #${recordId}'s last known status is "${details.status}", `
                    + 'not ERROR -- run "Check Status" first to confirm this feed has actually failed before resubmitting it.';
            }
            if (details.feedType !== 'price' && details.feedType !== 'inventory') {
                return `customrecord_wal_feed_submission #${recordId} is FEED_TYPE "${details.feedType}", which `
                    + 'can\'t be resubmitted from its tracking record alone (only "price" and "inventory" feeds can). '
                    + 'For an "MP_ITEM" content feed, re-run wm_mr_tire_upload.js instead.';
            }

            // Warns rather than hard-blocking -- an earlier retry may have
            // failed too and genuinely need another attempt -- but requires
            // explicit confirmation so this doesn't silently create a
            // second/third resubmission of the same feed.
            const existingRetries = findExistingRetries(recordId);
            if (existingRetries.length && !confirmReretry) {
                const list = existingRetries
                    .map((r) => `  - customrecord_wal_feed_submission #${r.id}, feedId=${r.feedId}, status=${r.status}`)
                    .join('\n');
                return `customrecord_wal_feed_submission #${recordId} was already retried ${existingRetries.length} `
                    + `time(s):\n${list}\n\nCheck "Resubmit anyway" below and submit again if you still want to `
                    + 'create another resubmission of this feed (e.g. because that earlier retry also failed).';
            }

            let items;
            try {
                items = JSON.parse(details.skus || '[]');
            } catch (e) {
                return `customrecord_wal_feed_submission #${recordId}'s SKUS field isn't valid JSON -- can't rebuild the feed: ${e.message}`;
            }
            if (!items.length) {
                return `customrecord_wal_feed_submission #${recordId} has no SKUS to resubmit.`;
            }

            const baseUrl = getBaseUrl(details.environment);
            let resultText;
            let correlationId = random.generateUUID();
            try {
                const accessToken = getAccessToken({ clientId, clientSecret, baseUrl, correlationId });
                correlationId = random.generateUUID();
                const newFeedId = submitResubmittedFeed({
                    accessToken, baseUrl, feedType: details.feedType, items, correlationId
                });

                const newRecordId = recordRetrySubmission({
                    feedId: newFeedId,
                    itemCount: items.length,
                    environment: details.environment,
                    correlationId,
                    skus: details.skus,
                    feedType: details.feedType,
                    itemType: details.itemType,
                    retryOfRecordId: recordId
                });

                resultText = `Resubmitted successfully. New feedId: ${newFeedId}\n`
                    + `New tracking record: customrecord_wal_feed_submission #${newRecordId} `
                    + `(retryOf #${recordId})\n\n`
                    + `correlationId: ${correlationId} (reference this if you need to ask Walmart support about this feed)\n\n`
                    + 'Check this new Feed ID\'s status separately once Walmart has had time to process it.';
            } catch (e) {
                resultText = `Resubmit failed: ${e.message}\n\ncorrelationId: ${correlationId}\n\n`
                    + `The original failed record (#${recordId}) was left untouched -- see execution log for full details.`;
                log.error({ title: `Feed resubmission failed (feedId=${feedId}, correlationId=${correlationId})`, details: e });
            }

            return resultText;
        }

        const onRequest = (context) => {
            if (context.request.method !== 'POST') {
                context.response.writePage(buildForm({}));
                return;
            }

            const feedId = context.request.parameters.custpage_feed_id;
            const action = context.request.parameters.custpage_action || 'check';
            const confirmReretry = context.request.parameters.custpage_confirm_reretry === 'T';

            if (!feedId) {
                context.response.writePage(buildForm({ action, resultText: 'Feed ID is required.' }));
                return;
            }

            const { clientId, clientSecret, defaultEnvironment } = getScriptParams();
            if (!clientId || !clientSecret) {
                context.response.writePage(buildForm({
                    feedId,
                    action,
                    resultText: 'Missing custscript_wal_feed_client_id / custscript_wal_feed_client_secret script parameters.'
                }));
                return;
            }

            const baseUrl = getBaseUrl(defaultEnvironment);
            const resultText = action === 'resubmit'
                ? handleResubmit({ feedId, clientId, clientSecret, confirmReretry })
                : handleCheckStatus({ feedId, environment: defaultEnvironment, clientId, clientSecret, baseUrl });

            context.response.writePage(buildForm({ feedId, action, resultText }));
        };

        return { onRequest };
    }
);
