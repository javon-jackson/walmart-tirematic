/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * 
 * Ops tool for shipping a Walmart order: enables buying shipping labels through 
 * Walmart at their provided rates or attaching our own tracking number to a box.
 * Then notifies Walmart that the order has shipped and updates the NetSuite Sales Order 
 * with the outbound date and the shipping carrier.
 *
 * Box model -- ONE BOX PER UNIT ORDERED
 *
 * Two-step flow, both via this same Suitelet:
 *   STEP 1 (GET_RATES): user enters a Walmart purchaseOrderId. This script
 *     looks up the matching customrecord_wal_order_import_lock row (the same
 *     authoritative "is this really a Walmart order" check wm_ue_order_shipped.js
 *     used) to get the Sales Order, re-fetches the order from Walmart, expands
 *     it into individual boxes (getOrderBoxes() -- TODO placeholder Item
 *     fields, see below), and calls Walmart's Shipping Estimates API ONCE PER
 *     BOX to get independent real rate quotes for each one (different boxes
 *     can reasonably get different carriers/services). Renders a form with
 *     one rate-picker per box, PLUS an optional "or your own carrier/tracking"
 *     pair of fields next to it (see below).
 *   STEP 2 (BUY_LABEL): user picks a rate for every box (or fills in their own
 *     carrier + tracking for any box they'd rather ship on a label printed
 *     outside this tool) and submits. PER BOX, independently: if that box's
 *     manual tracking field is filled in (and a carrier chosen), no Walmart
 *     label is bought for it at all -- its box.label object is built directly
 *     from what was typed in; if instead a real Walmart rate was chosen, that's
 *     used to buy a real Walmart label. A box selecting BOTH a real Walmart
 *     rate AND manual tracking is rejected outright (not silently resolved to
 *     one or the other) -- see handleBuyLabel()'s per-box validation. A single
 *     order can freely mix both across DIFFERENT boxes -- e.g. box 1 bought
 *     through Walmart, box 2 shipped on a label you already have. This script
 *     does, in order (this exact order matters -- see below):
 *       1. Acknowledge the order ONCE (POST .../acknowledge) -- defensive/
 *          required, same as wm_ue_order_shipped.js. Walmart requires
 *          acknowledgment before a label can be created, and before /shipping
 *          too (so this step still runs even if every box in an order ends up
 *          using manual tracking and no label gets bought at all).
 *       2. Re-fetch the order and regenerate the box list (getOrderBoxes()
 *          again) -- nothing from step 1 is trusted to still be current
 *          except which rate/manual-tracking entry was submitted for which box
 *          position. This assumes the order's lines/quantities haven't changed
 *          between step 1 and step 2 (a human picking rates takes seconds to
 *          minutes, not long enough for Walmart to alter the order in
 *          practice, but if the box count doesn't match what was quoted, this
 *          throws rather than silently misaligning entries to the wrong boxes).
 *       3. PER BOX: buy a label (POST /v3/shipping/labels) using its chosen
 *          carrier/service, UNLESS that box's manual tracking field was filled
 *          in, in which case skip straight to using the typed-in carrier/
 *          tracking as that box's label object -- no Walmart charge, no
 *          createLabel()/getLabelFile() call. Either way, this is what gives
 *          each box its label.carrierName/trackingNo. Each box's outcome is
 *          logged to customrecord_wal_shipment_notification immediately,
 *          before moving to the next box, so a later box's failure never loses
 *          a label that was already actually purchased. If ANY box fails, this
 *          stops instead of confirming shipment for a partial order.
 *       4. Confirm shipment with Walmart (POST .../shipping) in ONE call
 *          covering every box, grouped by lineNumber -- a line whose quantity
 *          spanned multiple boxes gets multiple orderLineStatus entries (one
 *          per box, statusQuantity 1 each, each with that box's own
 *          trackingInfo), not one shared block per line. This could NOT
 *          happen before step 3, since /shipping requires real tracking
 *          numbers that don't exist until every box's label.trackingNo is
 *          resolved (bought or typed in). (Earlier design discussion assumed
 *          ack+ship both had to happen before the label -- not possible given
 *          this data dependency, corrected in an earlier revision of this
 *          file.)
 *       5. Update the Sales Order: outbound date -> now, carrier field -> the
 *          single carrier name if every box used the same one, else the
 *          literal text "Multiple", tracking number field -> every box's
 *          tracking number joined with ", " (TODO placeholder field, see
 *          below). These two fields can't cleanly represent N independent
 *          boxes -- customrecord_wal_shipment_notification (one row per box)
 *          is the actual source of truth per box, including which ones were
 *          bought through Walmart vs. shipped on their own label.
 *
 * Partial/deferred shipment -- a box can ALSO be left for a later visit rather
 * than decided right now: leaving BOTH its rate dropdown at the default
 * "-- Skip Walmart label --" sentinel AND its manual tracking field blank
 * means "decide later," not "buy the first rate." That box is simply excluded
 * from this submission -- no label bought, no notification row written, no
 * Walmart /shipping call for it. Coming back to the SAME purchaseOrderId later
 * (STEP 1 again) re-shows only what's still outstanding: findShippedCountsBySku()
 * counts, per SKU, how many of this order's rows already reached a final
 * "...shipping confirmed with Walmart" status, and getOrderBoxes() subtracts
 * that from each line's quantity before expanding into boxes. This is a SKU-
 * count match, not a true per-box identity (Walmart's order data has no
 * concept of "box", only line quantity, and customrecord_wal_shipment_notification
 * doesn't store lineNumber) -- correct as long as a real order never repeats
 * the same SKU across two separate order lines, which hasn't come up in this
 * project so far. A transitional row (LABEL_CREATED/TRACKING_SUBMITTED that
 * never reached its "...AND_SHIPPED" status, e.g. a partial-batch failure)
 * does NOT count as already-shipped, so that box is offered again rather than
 * silently dropped.
 *
 *
 * TODO before this can be deployed -- do NOT guess real values into these:
 *   - BOX_WEIGHT_FIELD / BOX_LENGTH_FIELD / BOX_WIDTH_FIELD / BOX_HEIGHT_FIELD:
 *     the real Item field ids holding per-item box weight/dimensions (user
 *     confirmed these fields exist in NetSuite, exact ids not yet given).
 *     BOX_WEIGHT_UNIT / BOX_DIMENSION_UNIT below are ASSUMED fixed ('LB'/'IN')
 *     rather than read from a field -- confirm that assumption too.
 *   - TRACKING_NUMBER_FIELD: the real Sales Order field id this script WRITES
 *     the returned tracking number to.
 *   - TIREMATIC_FROM_ADDRESS: the real ship-from address (confirmed to be the
 *     NetSuite Tirematic customer's address, exact values not yet provided).
 *   - Confirmed (not a placeholder anymore): CARRIER_FIELD is a List/Record
 *     field -- writing Walmart's returned carrier name as raw text threw a real
 *     "Invalid ... reference key" error via record.submitFields(), which only
 *     accepts a list entry's internal id, never display text. Fixed via
 *     CARRIER_INTERNAL_ID_MAP/lookupCarrierInternalId() -- confirmed real
 *     internal ids for the 4 Walmart-relevant carriers (Fedex=1/UPS=2/USPS=3/
 *     RL Carriers="R&L"=5).
 *     Still unhandled: the "Multiple" case (boxes with different carriers)
 *     just skips setting this field rather than resolving to any list value.
 *   - customrecord_wal_shipment_notification -- still needs to be created in
 *     NetSuite (same as wm_ue_order_shipped.js's proposal), now with SKU/
 *     ITEM_NAME/LABEL_FILE/SHIP_DATE fields too -- see SHIP_NOTIFICATION_RECORD.
 *   - SHIP_NOTIFICATION_RECORD.FIELDS.RATE / .METHOD: two more fields still
 *     need to be created on that same record (shipping rate charged and the
 *     carrierServiceType actually used to buy each box's label) -- currently
 *     null placeholders, guarded off in recordShipmentNotification() the same
 *     way TRACKING_NUMBER_FIELD is, so nothing breaks until real field ids are
 *     filled in.
 *   - SHIP_NOTIFICATION_RECORD.FIELDS.BOX_NUMBER: another new field, same
 *     null-placeholder/guarded pattern -- holds a human-friendly "Box 2 of 4"
 *     string so a multi-tire order's rows are identifiable as belonging
 *     together in a plain list view of this record, without cross-referencing
 *     PO_ID/CORRELATION. Named NUMBER rather than LABEL to avoid colliding
 *     with this file's existing "label" meaning (the shipping label PDF/
 *     object returned by createLabel()).
 *   - SHIP_NOTIFICATION_RECORD.FIELDS.ADDRESS: another new field, same
 *     null-placeholder/guarded pattern -- holds the order's formatted ship-to
 *     address (see formatShipToAddress()), same for every box on a given
 *     order since they all ship to the same destination.
 *   - Confirmed (not a placeholder anymore): label files ARE now persisted to
 *     the File Cabinet, into a real folder (LABEL_FOLDER_ID) the user created
 *     for this -- see saveLabelFile()'s comment.
 *   - Confirmed (not a placeholder anymore): Create Label and Shipping Estimates
 *     use TWO DIFFERENT address shapes -- see toEstimatesAddress()'s comment.
 *     Country is the 2-letter "US" for both (confirmed against Walmart's own
 *     documented Create Label sample request; an earlier revision of this file
 *     guessed "USA" without checking a real sample and was wrong). Still
 *     unconfirmed: whether sandbox's Shipping Estimates API can ever return a
 *     real (non-stub) response for realistic order data at all -- its 400
 *     responses come back with a "Matched-Stub-Name" header, meaning sandbox
 *     for this specific API family is a canned stub server that only succeeds
 *     for Walmart's own exact documented sample payloads, not live-computed
 *     rates for arbitrary input. This may mean end-to-end sandbox testing of
 *     the rate-shopping step is not possible at all, only in PRODUCTION.
 *
 * Script parameters:
 *   custscript_wal_ship_confirm_client_id  - Walmart Marketplace API Client ID
 *   custscript_wal_ship_confirm_secret     - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_ship_confirm_env        - "PRODUCTION" or "SANDBOX"
 */
define(
    ['N/record', 'N/search', 'N/runtime', 'N/https', 'N/encode', 'N/log', 'N/crypto/random', 'N/ui/serverWidget', 'N/ui/message', 'N/file', 'N/url', 'N/format'],
    (record, search, runtime, https, encode, log, random, serverWidget, message, file, url, format) => {

        const BASE_URLS = {
            PRODUCTION: 'https://marketplace.walmartapis.com',
            SANDBOX: 'https://sandbox.walmartapis.com'
        };

        const BUTTON_STYLE = 'display:inline-block;padding:10px 20px;background:#187bf2;color:#fff;'
            + 'font-weight:bold;font-size:14px;text-decoration:none;border-radius:3px;border:none;cursor:pointer;';

        const SECONDARY_LINK_STYLE = 'color:#666;font-size:13px;text-decoration:underline;';

        const PARAMS = {
            CLIENT_ID: 'custscript_wal_ship_confirm_client_id',
            CLIENT_SECRET: 'custscript_wal_ship_confirm_secret',
            ENVIRONMENT: 'custscript_wal_ship_confirm_env'
        };

        // TODO: confirm fields
        const STATUS_FIELD = 'custbody_sales_order_status'; // same field wm_mr_order_import.js sets at creation
        const SHIPPED_STATUS_VALUE = '1'; // SO Status "Ready"
        const OUTBOUND_DATE_FIELD = 'custbody_outbound_date';
        const CARRIER_FIELD = 'custbody_shipping_carrier';
        const TRACKING_NUMBER_FIELD = null; // TODO

        const CARRIER_INTERNAL_ID_MAP = {
            'FEDEX': '1', // NetSuite list value "Fedex"
            'UPS': '2',
            'USPS': '3',
            'RL CARRIERS': '5' // NetSuite list value "R&L" -- Walmart's carrier name for this one is "RL Carriers"
        };

        const MANUAL_CARRIER_DISPLAY_NAMES = {
            'FEDEX': 'FedEx',
            'UPS': 'UPS',
            'USPS': 'USPS',
            'RL CARRIERS': 'RL Carriers'
        };

        const BOX_WEIGHT_FIELD = 'custitem48';
        const BOX_LENGTH_FIELD = 'custitem_pacejet_item_length'; 
        const BOX_WIDTH_FIELD = 'custitem_pacejet_item_width'; 
        const BOX_HEIGHT_FIELD = 'custitem_pacejet_item_height'; 
        const BOX_WEIGHT_UNIT = 'LB'; 
        const BOX_DIMENSION_UNIT = 'IN'; 

        const LABEL_FOLDER_ID = 5813965;

        // TODO: verify this address is correct.
        const TIREMATIC_FROM_ADDRESS = {
            contactName: 'TireMatic', 
            addressLine1: '7901 4th ST N STE 300', 
            city: 'St. Petersburg', 
            state: 'FL', 
            postalCode: '33702', 
            country: 'US', 
            phone: '844-508-2886' 
        };

        const LOCK_RECORD_TYPE = 'customrecord_wal_order_import_lock';
        const LOCK_FIELDS = {
            SALES_ORDER: 'custrecord_wal_lock_sales_order',
            PO_ID: 'custrecord_wal_lock_po_id'
        };

        const SHIP_NOTIFICATION_RECORD = {
            TYPE: 'customrecord_wal_shipping_notification',
            FIELDS: {
                PO_ID: 'custrecord_wal_shipnotif_po_id',
                SALES_ORDER: 'custrecord_wal_shipnotif_sales_order',
                STATUS: 'custrecord_wal_shipnotif_status',
                ERROR: 'custrecord_wal_shipnotif_error',
                CORRELATION: 'custrecord_wal_shipnotif_correlation_id',
                TRACKING: 'custrecord_wal_shipnotif_tracking',
                CARRIER: 'custrecord_wal_shipnotif_carrier',
                SKU: 'custrecord_wal_shipnotif_sku',
                ITEM_NAME: 'custrecord_wal_shipnotif_item_name',
                LABEL_FILE: 'custrecord_wal_shipnotif_label',
                SHIP_DATE: 'custrecord_wal_shipnotif_ship_date',
                RATE: 'custrecord_wal_shipnotif_ship_rate',
                METHOD: 'custrecord_wal_shipnotif_ship_method',
                BOX_NUMBER: 'custrecord_wal_shipnotif_box_num',
                ADDRESS: 'custrecord_wal_shipnotif_ship_address'
            },
            STATUS: {
                LABEL_CREATED: 'Label created',
                LABEL_CREATED_AND_SHIPPED: 'Label created, shipping confirmed with Walmart',
                TRACKING_SUBMITTED: 'Tracking submitted',
                TRACKING_SUBMITTED_AND_SHIPPED: 'Tracking submitted, shipping confirmed with Walmart',
                ERROR: 'Error'
            }
        };

        const ACTION = {
            GET_RATES: 'getRates',
            BUY_LABEL: 'buyLabel'
        };

        function onRequest(context) {
            const request = context.request;
            const action = request.parameters.custpage_action;

            try {
                if (request.method !== 'POST') {
                    context.response.writePage(buildLookupForm());
                    return;
                }

                if (action === ACTION.GET_RATES) {
                    handleGetRates(context);
                } else if (action === ACTION.BUY_LABEL) {
                    handleBuyLabel(context);
                } else {
                    context.response.writePage(buildLookupForm('Unknown action -- please start again.'));
                }
            } catch (e) {
                log.error('Unhandled error', {
                    action, errorName: e && e.name, errorMessage: e && e.message
                });
                context.response.writePage(buildResultPage({
                    success: false,
                    message: e && e.message,
                    correlationId: null
                }));
            }
        }

        function buildLookupForm(errorMessage) {
            const form = serverWidget.createForm({ title: 'Ship Walmart Order' });
            if (errorMessage) {
                form.addPageInitMessage({ type: message.Type.ERROR, title: 'Error', message: errorMessage });
            }
            const group = addSingleColumnGroup(form, 'custpage_lookup_group');

            const poField = form.addField({
                id: 'custpage_po_id', type: serverWidget.FieldType.TEXT, label: 'Walmart Purchase Order ID', container: group
            });
            poField.isMandatory = true;

            // Both optional -- passed to Walmart's Shipping Estimates API as shipByDate/
            // deliverByDate filters if set. Left blank, Walmart just returns every
            // available option with no deadline filtering.
            form.addField({
                id: 'custpage_ship_by_date', type: serverWidget.FieldType.DATE, label: 'Ship By Date (optional)', container: group
            });
            form.addField({
                id: 'custpage_deliver_by_date', type: serverWidget.FieldType.DATE, label: 'Deliver By Date (optional)', container: group
            });

            form.addSubmitButton({ label: 'Get Shipping Rates' });
            // Suitelet forms submit to their own URL by default -- action param added via a hidden field
            // so onRequest can tell this apart from the buy-label step.
            const actionField = form.addField({
                id: 'custpage_action', type: serverWidget.FieldType.TEXT, label: 'Action', container: group
            });
            actionField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            actionField.defaultValue = ACTION.GET_RATES;
            return form;
        }

        /** STEP 1: look up the order, get real rate quotes from Walmart, render a form to pick one. */
        function handleGetRates(context) {
            const purchaseOrderId = context.request.parameters.custpage_po_id;
            if (!purchaseOrderId) {
                context.response.writePage(buildLookupForm('Enter a Walmart Purchase Order ID.'));
                return;
            }

            const lock = findWalmartLockByPoId(purchaseOrderId);
            if (!lock) {
                context.response.writePage(buildLookupForm(`No Walmart import record found for purchaseOrderId "${purchaseOrderId}" -- confirm this order was actually imported.`));
                return;
            }

            const ctx = getScriptParams();
            const baseUrl = BASE_URLS[ctx.environment] || BASE_URLS.SANDBOX;
            const correlationId = random.generateUUID();
            const accessToken = getWalmartAccessToken({ clientId: ctx.clientId, clientSecret: ctx.clientSecret, baseUrl, correlationId });

            const orderDetails = getOrderDetails({ accessToken, baseUrl, purchaseOrderId, correlationId, environment: ctx.environment });
            
            // Excludes boxes already shipped on an earlier visit to this same PO
            const shippedCountsBySku = findShippedCountsBySku(purchaseOrderId);
            const boxes = getOrderBoxes(orderDetails, shippedCountsBySku);
            if (!boxes.length) {
                const message = Object.keys(shippedCountsBySku).length
                    ? `Every box on Walmart order "${purchaseOrderId}" has already been shipped.`
                    : `Walmart order "${purchaseOrderId}" has no usable order lines.`;
                context.response.writePage(buildLookupForm(message));
                return;
            }
            const toAddress = buildWalmartAddress(orderDetails.shippingInfo && orderDetails.shippingInfo.postalAddress);
            
            // Shipping Estimates uses a DIFFERENT address shape than Create Label.
            const estimatesFromAddress = toEstimatesAddress(TIREMATIC_FROM_ADDRESS);
            const estimatesToAddress = toEstimatesAddress(toAddress);

            // Both optional. includeServicesNotMeetingDeliveryPromise is sent explicitly as
            // FALSE whenever a deliverByDate is set -- asking Walmart to only return options
            // that actually meet the promise.
            const shipByDate = parseDateFieldToIso(context.request.parameters.custpage_ship_by_date);
            const deliverByDate = parseDateFieldToIso(context.request.parameters.custpage_deliver_by_date);

            // Independent rate quote per box. A box with no returned estimates just gets an
            // empty rate dropdown on the rate-selection form, manual tracking is always available
            // as a fallback.
            const boxEstimates = boxes.map((box) => ({
                box,
                estimates: getShippingEstimates({
                    accessToken, baseUrl, correlationId, environment: ctx.environment,
                    purchaseOrderId, boxDimensions: box.boxDimensions, boxItems: box.boxItems,
                    fromAddress: estimatesFromAddress, toAddress: estimatesToAddress,
                    shipByDate, deliverByDate,
                    includeServicesNotMeetingDeliveryPromise: deliverByDate ? false : null
                })
            }));

            context.response.writePage(buildRateSelectionForm({ purchaseOrderId, salesOrderId: lock.salesOrderId, boxEstimates }));
        }

        function buildRateSelectionForm(params) {
            const { purchaseOrderId, salesOrderId, boxEstimates } = params;
            const form = serverWidget.createForm({ title: 'Pick a Shipping Rate for Each Box' });
            const group = addSingleColumnGroup(form, 'custpage_rates_group');

            const poField = form.addField({ id: 'custpage_po_id', type: serverWidget.FieldType.TEXT, label: 'Walmart Purchase Order ID', container: group });
            poField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
            poField.defaultValue = purchaseOrderId;

            const soField = form.addField({ id: 'custpage_sales_order_id', type: serverWidget.FieldType.TEXT, label: 'Sales Order Internal ID', container: group });
            soField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
            soField.defaultValue = String(salesOrderId);

            const actionField = form.addField({ id: 'custpage_action', type: serverWidget.FieldType.TEXT, label: 'Action', container: group });
            actionField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            actionField.defaultValue = ACTION.BUY_LABEL;

            // Step 2 regenerates the same box list fresh and matches entries back up by
            // array index.
            const countField = form.addField({ id: 'custpage_box_count', type: serverWidget.FieldType.TEXT, label: 'Box Count', container: group });
            countField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            countField.defaultValue = String(boxEstimates.length);

            const instructionsField = form.addField({ id: 'custpage_instructions', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
            instructionsField.defaultValue = '<p>For each box below: pick a Walmart rate to buy a label through Walmart, '
                + 'OR fill in your own carrier + tracking number to ship it on a label you already have (no Walmart charge for that box). '
                + '<strong>Choose only one of the two per box</strong> -- selecting a rate AND entering your own tracking for the same box will be rejected. '
                + 'Leave BOTH blank to skip that box for now -- it stays outstanding and shows up again next time you look up this PO.</p>';

            boxEstimates.forEach((boxEstimate, index) => {
                const { box, estimates } = boxEstimate;

                const headingField = form.addField({
                    id: 'custpage_box_heading_' + index, type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group
                });
                headingField.defaultValue = `<h3 style="margin:16px 0 4px;border-top:1px solid #ddd;padding-top:12px;">`
                    + `BOX ${index + 1} of ${boxEstimates.length} (${box.sku})</h3>`;

                const rateField = form.addField({
                    id: 'custpage_rate_' + index, type: serverWidget.FieldType.SELECT,
                    label: 'Walmart Shipping Rate',
                    container: group
                });
                
                rateField.addSelectOption({ value: '', text: '-- Skip Walmart label --', isSelected: true });
                estimates.forEach((estimate) => {
                    const price = estimate.estimatedRate && estimate.estimatedRate.amount;
                    const value = `${estimate.carrierName}::${estimate.name}::${price != null ? price : ''}`;
                    const label = `${estimate.carrierDisplayName || estimate.carrierName} - ${estimate.displayName || estimate.name}`
                        + (price != null ? ` - $${price}` : '')
                        + (estimate.deliveryDate ? ` (est. delivery ${estimate.deliveryDate})` : '');
                    rateField.addSelectOption({ value, text: label });
                });

                const manualCarrierField = form.addField({
                    id: 'custpage_manual_carrier_' + index, type: serverWidget.FieldType.SELECT,
                    label: 'OR Your Own Carrier',
                    container: group
                });
                manualCarrierField.addSelectOption({ value: '', text: '-- Skip manual tracking --', isSelected: true });
                Object.keys(MANUAL_CARRIER_DISPLAY_NAMES).forEach((key) => {
                    manualCarrierField.addSelectOption({ value: key, text: MANUAL_CARRIER_DISPLAY_NAMES[key] });
                });

                form.addField({
                    id: 'custpage_manual_tracking_' + index, type: serverWidget.FieldType.TEXT,
                    label: 'OR Your Own Tracking Number',
                    container: group
                });
            });

            form.addSubmitButton({ label: 'Buy Labels & Confirm Shipment with Walmart' });

            const startOverField = form.addField({ id: 'custpage_start_over', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
            startOverField.defaultValue = '<div style="padding:10px 0;">'
                + `<a href="${buildSuiteletUrl()}" style="${SECONDARY_LINK_STYLE}">Start over</a>`
                + '</div>';

            return form;
        }

        /**
         * STEP 2: acknowledge -> per box, either buy a Walmart label OR use manually
         * entered tracking OR skip (decide later) -> confirm shipment with Walmart (one
         * call covering whatever boxes were actually acted on this round) -> update
         * Sales Order -> log. See header comment for the full per-box mixing/deferral
         * design.
         */
        function handleBuyLabel(context) {
            const request = context.request;
            const purchaseOrderId = request.parameters.custpage_po_id;
            const salesOrderId = request.parameters.custpage_sales_order_id;
            const boxCount = Number(request.parameters.custpage_box_count) || 0;

            if (!purchaseOrderId || !salesOrderId || !boxCount) {
                context.response.writePage(buildResultPage({ success: false, message: 'Missing purchaseOrderId, Sales Order id, or box selections -- please start again.' }));
                return;
            }

            // Parsed once up front, before any Walmart calls -- each box independently
            // resolves to exactly one of: buy via Walmart (a real rate was chosen),
            // manual tracking (typed in), or skip (both left blank -- decide later). 
            // A box can't be both -- picking a real Walmart rate AND
            // filling in manual tracking for the same box is rejected outright rather than
            // silently preferring one, so a mistaken double-entry never buys/skips a label
            // the user didn't actually mean to.
            const boxDecisions = [];
            for (let i = 0; i < boxCount; i++) {
                const rawRate = request.parameters['custpage_rate_' + i] || '';
                const manualCarrierKey = request.parameters['custpage_manual_carrier_' + i] || '';
                const manualTrackingNo = String(request.parameters['custpage_manual_tracking_' + i] || '').trim();
                const hasRate = !!rawRate;
                const hasManual = !!manualTrackingNo;

                if (hasRate && hasManual) {
                    context.response.writePage(buildResultPage({ success: false, message: `Box ${i + 1}: choose EITHER a Walmart shipping rate OR your own tracking number, not both -- please start again.` }));
                    return;
                }

                if (hasManual && !manualCarrierKey) {
                    context.response.writePage(buildResultPage({ success: false, message: `Box ${i + 1}: a carrier must be selected when providing your own tracking number -- please start again.` }));
                    return;
                }

                if (!hasManual && !hasRate) {
                    boxDecisions.push({ skip: true });
                    continue;
                }

                if (hasManual) {
                    boxDecisions.push({ skip: false, useManual: true, manualCarrierKey, manualTrackingNo });
                } else {
                    const [carrierName, carrierServiceType, rateAmount] = rawRate.split('::');
                    boxDecisions.push({ skip: false, useManual: false, carrierName, carrierServiceType, rateAmount: rateAmount || null });
                }
            }

            if (boxDecisions.every((d) => d.skip)) {
                context.response.writePage(buildResultPage({ success: false, message: 'No boxes were selected to ship -- choose a rate or enter your own tracking for at least one box, or come back later.' }));
                return;
            }

            const ctx = getScriptParams();
            const baseUrl = BASE_URLS[ctx.environment] || BASE_URLS.SANDBOX;
            const correlationId = random.generateUUID();
            // Declared outside the try block so the catch below can still
            // read whichever box was in flight, or the ship-to address, when a failure
            // happened.
            let currentBoxNumber = null;
            let shipToAddressText = null;

            try {
                const accessToken = getWalmartAccessToken({ clientId: ctx.clientId, clientSecret: ctx.clientSecret, baseUrl, correlationId });

                // 1. Acknowledge ONCE for the whole order -- required before any label can be
                // created, and before /shipping too, so this still runs even if every box this
                // round turns out to use manual tracking (no label bought at all).
                acknowledgeOrder({ accessToken, baseUrl, purchaseOrderId, correlationId, environment: ctx.environment });

                // Re-fetch fresh and regenerate the same (already-shipped-excluded) box list
                // step 1 built -- see header comment on this index-alignment assumption
                // between the two steps. TODO: ???
                const orderDetails = getOrderDetails({ accessToken, baseUrl, purchaseOrderId, correlationId, environment: ctx.environment });
                const shippedCountsBySku = findShippedCountsBySku(purchaseOrderId);
                const boxes = getOrderBoxes(orderDetails, shippedCountsBySku);
                if (boxes.length !== boxDecisions.length) {
                    throw new Error(`Order now has ${boxes.length} outstanding box(es) but ${boxDecisions.length} selection(s) were submitted -- the order may have changed since rates were quoted. Please start again.`);
                }

                // Same destination for every box on this order
                shipToAddressText = formatShipToAddress(buildWalmartAddress(orderDetails.shippingInfo && orderDetails.shippingInfo.postalAddress));

                const shipDate = new Date();

                // 2. Resolve each ACTED-ON box (skipped ones are left out entirely -- no
                // label, no notification row, no Walmart /shipping entry; they stay
                // outstanding for a later visit). Logging each success immediately so a
                // later box's failure never loses a label that was already actually
                // purchased. currentBoxNumber tracks which box is in flight so the outer
                // catch below can attach it to an error notification too, not just
                // successes. Box numbering ("Box X of N") uses each box's position among
                // ALL boxes still outstanding this round (boxes.length, including any left
                // skipped this round) -- NOT just the acted-on subset, so shipping only 1 of
                // 2 outstanding boxes still reads "Box 1 of 2", not the misleading "Box 1 of 1".
                const activeEntries = [];
                boxDecisions.forEach((decision, i) => { if (!decision.skip) activeEntries.push({ box: boxes[i], decision, originalIndex: i }); });

                const labels = [];
                for (let entryIdx = 0; entryIdx < activeEntries.length; entryIdx++) {
                    const { box, decision, originalIndex } = activeEntries[entryIdx];
                    const boxNumber = `Box ${originalIndex + 1} of ${boxes.length}`;
                    currentBoxNumber = boxNumber;

                    let label, labelDataUri = null, labelFileId = null, notifStatus, shippingMethod, rate;

                    if (decision.useManual) {
                        const carrierDisplayName = MANUAL_CARRIER_DISPLAY_NAMES[decision.manualCarrierKey] || decision.manualCarrierKey;
                        label = { carrierName: carrierDisplayName, trackingNo: decision.manualTrackingNo };
                        notifStatus = SHIP_NOTIFICATION_RECORD.STATUS.TRACKING_SUBMITTED;
                        // No real carrierServiceType/rate to log -- createLabel() was never called.
                        shippingMethod = 'MANUAL_EXTERNAL_LABEL';
                        rate = null;
                    } else {
                        label = createLabel({
                            accessToken, baseUrl, correlationId, environment: ctx.environment,
                            purchaseOrderId, boxDimensions: box.boxDimensions, boxItems: box.boxItems,
                            carrierName: decision.carrierName, carrierServiceType: decision.carrierServiceType,
                            fromAddress: TIREMATIC_FROM_ADDRESS
                        });

                        // Retrieving + saving the label file is NON-FATAL -- the label is already
                        // bought and paid for by this point regardless, so a failure here just
                        // means no preview/saved file for this box, not a failed shipment.
                        try {
                            const pdfBytes = getLabelFile({
                                accessToken, baseUrl, correlationId, environment: ctx.environment,
                                carrierShortName: label.carrierName, trackingNo: label.trackingNo
                            });
                            const saved = saveLabelFile(pdfBytes, `label-box${originalIndex + 1}-${label.trackingNo}.pdf`);
                            labelDataUri = saved.dataUri;
                            labelFileId = saved.fileId;
                        } catch (labelFileError) {
                            log.error('Failed to retrieve/save label file (label purchase itself succeeded)', {
                                purchaseOrderId, trackingNo: label.trackingNo, errorMessage: labelFileError && labelFileError.message
                            });
                        }

                        notifStatus = SHIP_NOTIFICATION_RECORD.STATUS.LABEL_CREATED;
                        shippingMethod = decision.carrierServiceType;
                        rate = decision.rateAmount;
                    }

                    const notifId = recordShipmentNotification({
                        purchaseOrderId, salesOrderId, status: notifStatus,
                        trackingNumber: label.trackingNo, carrierName: label.carrierName,
                        sku: box.sku, itemName: box.productName, labelFileId, shipDate, correlationId,
                        shippingMethod, rate, boxNumber, shippingAddress: shipToAddressText
                    });
                    labels.push({ box, label, labelDataUri, manual: decision.useManual, notifId, originalIndex });
                }

                // 3. Confirm shipment with Walmart (just the boxes acted on this round)
                // 4. update the Sales Order
                const { trackingNumbers } = confirmShipmentAndUpdateSalesOrder({
                    accessToken, baseUrl, correlationId, environment: ctx.environment,
                    purchaseOrderId, salesOrderId, orderDetails, labels, shipDate
                });

                markShipmentNotificationsConfirmed(labels);

                const boughtCount = labels.filter((l) => !l.manual).length;
                const manualCount = labels.length - boughtCount;
                const skippedCount = boxDecisions.length - labels.length;
                context.response.writePage(buildResultPage({
                    success: true,
                    message: `Shipment confirmed with Walmart across ${labels.length} box(es)`
                        + ` (${boughtCount} label(s) bought via Walmart, ${manualCount} using your own tracking).`
                        + (skippedCount ? ` ${skippedCount} box(es) left for a later visit.` : '')
                        + ` Tracking: ${trackingNumbers.join(', ')}.`,
                    correlationId,
                    labels,
                    totalBoxes: boxes.length
                }));
            } catch (e) {
                log.error('Failed to buy labels / confirm shipment', {
                    purchaseOrderId, salesOrderId, errorName: e && e.name, errorMessage: e && e.message
                });
                recordShipmentNotification({
                    purchaseOrderId, salesOrderId, status: SHIP_NOTIFICATION_RECORD.STATUS.ERROR, errorMessage: e && e.message,
                    boxNumber: currentBoxNumber,
                    shippingAddress: shipToAddressText
                });
                context.response.writePage(buildResultPage({ success: false, message: e && e.message, correlationId }));
            }
        }

        /**
         * Tail of handleBuyLabel(): confirms shipment with Walmart (one call covering
         * whichever boxes were actually acted on this round, grouped by lineNumber) then
         * updates the Sales Order (outbound date/carrier/tracking). Returns the tracking
         * numbers/carrier names actually used rather than writing the result page itself,
         * since the success message needs the bought-vs-manual-vs-skipped breakdown too.
         */
        function confirmShipmentAndUpdateSalesOrder(params) {
            const { accessToken, baseUrl, correlationId, environment, purchaseOrderId, salesOrderId, orderDetails, labels, shipDate } = params;

            const shipPayload = buildShipmentPayload({ orderDetails, labels, shipDateTime: shipDate.getTime() });
            submitShippingConfirmation({ accessToken, baseUrl, purchaseOrderId, correlationId, environment, payload: shipPayload });

            // Multiple boxes can have different tracking numbers/carriers -- join tracking
            // numbers; CARRIER_FIELD only gets set when every box actually used the same
            // carrier, since there's no valid list entry for "mixed carriers" (see
            // CARRIER_INTERNAL_ID_MAP's comment).
            const trackingNumbers = labels.map((l) => l.label.trackingNo);
            const carrierNames = Array.from(new Set(labels.map((l) => l.label.carrierName)));
            const soValues = {};
            // soValues[STATUS_FIELD] = SHIPPED_STATUS_VALUE; TODO dont update value in sales order
            soValues[OUTBOUND_DATE_FIELD] = shipDate;
            if (carrierNames.length === 1) {
                soValues[CARRIER_FIELD] = lookupCarrierInternalId(carrierNames[0]);
            } else {
                log.audit('Multiple distinct carriers across boxes, leaving custbody_shipping_carrier unset', {
                    purchaseOrderId, salesOrderId, carrierNames
                });
            }
            if (TRACKING_NUMBER_FIELD) soValues[TRACKING_NUMBER_FIELD] = trackingNumbers.join(', ');
            record.submitFields({
                type: record.Type.SALES_ORDER, id: salesOrderId, values: soValues,
                options: { enableSourcing: false, ignoreMandatoryFields: true }
            });

            return { trackingNumbers, carrierNames };
        }

        /**
         * Labels are shown INLINE here only, as a data: URI -- deliberately not saved to
         * the File Cabinet yet (testing only, per explicit instruction). TODO once a real
         * folder id is available: buildLabelDataUri()'s in-memory file.File object is
         * already the right shape to persist -- just call .save({folder: <id>}) on it
         * there instead of discarding it after getContents().
         */
        function buildResultPage(params) {
            const { success, message, correlationId, labels, totalBoxes } = params;
            const form = serverWidget.createForm({ title: success ? 'Shipment Confirmed' : 'Shipment Failed' });
            const text = [
                success ? 'Success.' : 'Error.',
                message,
                correlationId ? `\n\ncorrelationId: ${correlationId} (reference this if you need to ask Walmart support about this order)` : ''
            ].filter(Boolean).join(' ');

            const resultField = form.addField({ id: 'custpage_result', type: serverWidget.FieldType.LONGTEXT, label: 'Result' });
            resultField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
            resultField.defaultValue = text;

            if (labels && labels.length) {
                labels.forEach((entry, index) => {
                    // Uses the box's true position among everything still outstanding this
                    // round (totalBoxes), not just the acted-on subset -- shipping only 1 of 2
                    // outstanding boxes should read "Box 1 of 2", not the misleading "Box 1 of 1"
                    // (see handleBuyLabel()'s same fix). Falls back to the old labels-only count
                    // if totalBoxes wasn't passed (e.g. an unhandled-error page with no boxes context).
                    const boxNumber = totalBoxes
                        ? `Box ${entry.originalIndex + 1} of ${totalBoxes}`
                        : `Box ${index + 1} of ${labels.length}`;
                    const labelField = form.addField({
                        id: 'custpage_label_' + index, type: serverWidget.FieldType.INLINEHTML,
                        label: `Label - ${boxNumber}`
                    });
                    // Walmart hands back a carrier tracking-URL per label, not one for the whole
                    // order -- manual-tracking boxes never have one (no label was purchased),
                    // so this is shown right above that box's own line, not just once up top.
                    const trackingUrlLine = entry.label.trackingUrl ? `<p>Tracking URL: <a href="${entry.label.trackingUrl}" target="_blank">${entry.label.trackingUrl}</a></p>` : '';
                    labelField.defaultValue = trackingUrlLine + (entry.manual
                        // No Walmart label was ever purchased for this box (manual tracking was
                        // entered instead) -- entry.labelDataUri is always null here, so don't
                        // word it like a failed PDF retrieval the way the bought-label case below does.
                        ? `<p><strong>${boxNumber}</strong> (${entry.box.sku}, tracking ${entry.label.trackingNo}):`
                            + ` tracking entered manually -- no Walmart label purchased.</p>`
                        : entry.labelDataUri
                            ? `<p><strong>${boxNumber}</strong> (${entry.box.sku}, tracking ${entry.label.trackingNo}):`
                                + ` <a href="${entry.labelDataUri}" target="_blank">open in new tab</a></p>`
                                + `<embed src="${entry.labelDataUri}" type="application/pdf" width="100%" height="500" />`
                            : `<p><strong>${boxNumber}</strong> (${entry.box.sku}, tracking ${entry.label.trackingNo}):`
                                + ` label purchased, but the preview file could not be retrieved -- see execution log.</p>`);
                });
            }

            // Otherwise this page is a dead end -- a fresh GET of this same Suitelet
            // re-renders the initial lookup form so another PO# can be entered without
            // navigating away.
            const nextField = form.addField({ id: 'custpage_next', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
            nextField.defaultValue = '<div style="padding:10px 0;">'
                + `<a href="${buildSuiteletUrl()}" style="${BUTTON_STYLE}">Ship another order</a>`
                + '</div>';

            return form;
        }

        /**
         * This Suitelet's own bare URL -- shared by every "start over"/"ship another
         * order" plain link so the runtime/url calls aren't repeated at each spot.
         */
        function buildSuiteletUrl() {
            const script = runtime.getCurrentScript();
            return url.resolveScript({
                scriptId: script.id, deploymentId: script.deploymentId, returnExternalUrl: false
            });
        }

        /**
         * NetSuite Suitelet forms lay fields out in TWO columns by default, alternating
         * left/right in add order -- for a form that's really a sequential list (PO id,
         * then dates; or one rate-picker/tracking-entry per box) that reads as a
         * mismatched two-column table rather than a simple stacked list. A field group
         * with isSingleColumn set stacks every field assigned to it (via the `container`
         * option on addField()) in one column instead.
         */
        function addSingleColumnGroup(form, id) {
            const group = form.addFieldGroup({ id, label: ' ' });
            group.isSingleColumn = true;
            return id;
        }

        /** See CARRIER_INTERNAL_ID_MAP's comment -- resolves Walmart's returned carrier name to the NetSuite List/Record internal id, case-insensitively. */
        function lookupCarrierInternalId(walmartCarrierName) {
            const key = String(walmartCarrierName || '').trim().toUpperCase();
            const internalId = CARRIER_INTERNAL_ID_MAP[key];
            if (!internalId) {
                throw new Error(`No NetSuite custbody_shipping_carrier value mapped for Walmart carrier "${walmartCarrierName}" -- add it to CARRIER_INTERNAL_ID_MAP.`);
            }
            return internalId;
        }

        /** Same authoritative "is this a Walmart order" check as wm_ue_order_shipped.js, keyed by PO id instead of Sales Order id since that's what the user enters here. */
        function findWalmartLockByPoId(purchaseOrderId) {
            const lockSearch = search.create({
                type: LOCK_RECORD_TYPE,
                filters: [[LOCK_FIELDS.PO_ID, 'is', String(purchaseOrderId)]],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: LOCK_FIELDS.SALES_ORDER })
                ]
            });
            const results = lockSearch.run().getRange({ start: 0, end: 1 }) || [];
            if (!results.length) return null;

            return {
                id: results[0].getValue({ name: 'internalid' }),
                salesOrderId: results[0].getValue({ name: LOCK_FIELDS.SALES_ORDER })
            };
        }

        /**
         * Expands every order line's REMAINING quantity into that many individual box
         * objects -- one tire, one box, sized/weighed from that SKU's own NetSuite item
         * fields. See header comment's "box model" note. boxItems on each box is a
         * single-entry array (quantity 1) since each box holds exactly one unit;
         * lineNumber/sku come straight from the fresh Walmart order response.
         *
         * shippedCountsBySku (from findShippedCountsBySku(), optional -- omit or pass {}
         * for "nothing shipped yet") is subtracted from each line's quantity before
         * expanding, so a box already confirmed shipped on an earlier visit to this same
         * PO doesn't get offered again -- see header comment on partial/deferred
         * shipment. This is a SKU-count match, not true per-box identity, so a line whose
         * SKU also appears already-shipped from a DIFFERENT line would incorrectly have
         * its quantity reduced too -- accepted limitation, see header comment.
         */
        function getOrderBoxes(orderDetails, shippedCountsBySku) {
            shippedCountsBySku = shippedCountsBySku || {};
            const orderLines = (orderDetails.orderLines && orderDetails.orderLines.orderLine) || [];
            const boxes = [];

            for (const line of orderLines) {
                const sku = line.item && line.item.sku;
                const productName = line.item && line.item.productName;
                const orderedQuantity = Number(line.orderLineQuantity && line.orderLineQuantity.amount) || 0;
                if (!sku || orderedQuantity <= 0) continue;

                const remainingQuantity = Math.max(0, orderedQuantity - (shippedCountsBySku[sku] || 0));
                if (!remainingQuantity) continue;

                const itemFields = findItemBoxFieldsBySku(sku);

                for (let unit = 0; unit < remainingQuantity; unit++) {
                    boxes.push({
                        lineNumber: line.lineNumber,
                        sku,
                        productName,
                        boxDimensions: {
                            boxWeight: itemFields.weight,
                            boxWeightUnit: BOX_WEIGHT_UNIT,
                            boxLength: itemFields.length,
                            boxWidth: itemFields.width,
                            boxHeight: itemFields.height,
                            boxDimensionUnit: BOX_DIMENSION_UNIT
                        },
                        boxItems: [{ lineNumber: line.lineNumber, sku, quantity: 1 }]
                    });
                }
            }

            return boxes;
        }

        /**
         * Counts, per SKU, how many of this Walmart order's boxes already reached a
         * final "...shipping confirmed with Walmart" status on an earlier visit to this
         * Suitelet -- lets getOrderBoxes() exclude them so a partially-shipped order only
         * asks for a decision on what's still outstanding. See header comment for the
         * SKU-count-match tradeoff. A transitional row (LABEL_CREATED/TRACKING_SUBMITTED
         * that never reached its "...AND_SHIPPED" status, e.g. a partial-batch failure)
         * does NOT count -- that box is offered again rather than silently dropped.
         */
        function findShippedCountsBySku(purchaseOrderId) {
            const notifSearch = search.create({
                type: SHIP_NOTIFICATION_RECORD.TYPE,
                filters: [
                    [SHIP_NOTIFICATION_RECORD.FIELDS.PO_ID, 'is', String(purchaseOrderId)],
                    'and',
                    [
                        [SHIP_NOTIFICATION_RECORD.FIELDS.STATUS, 'is', SHIP_NOTIFICATION_RECORD.STATUS.LABEL_CREATED_AND_SHIPPED],
                        'or',
                        [SHIP_NOTIFICATION_RECORD.FIELDS.STATUS, 'is', SHIP_NOTIFICATION_RECORD.STATUS.TRACKING_SUBMITTED_AND_SHIPPED]
                    ]
                ],
                columns: [search.createColumn({ name: SHIP_NOTIFICATION_RECORD.FIELDS.SKU })]
            });

            const countsBySku = {};
            notifSearch.run().each((result) => {
                const sku = result.getValue({ name: SHIP_NOTIFICATION_RECORD.FIELDS.SKU });
                if (sku) countsBySku[sku] = (countsBySku[sku] || 0) + 1;
                return true;
            });
            return countsBySku;
        }

        function findItemBoxFieldsBySku(sku) {
            if (!BOX_WEIGHT_FIELD || !BOX_LENGTH_FIELD || !BOX_WIDTH_FIELD || !BOX_HEIGHT_FIELD) {
                throw new Error('Box dimension fields (BOX_WEIGHT_FIELD/BOX_LENGTH_FIELD/BOX_WIDTH_FIELD/BOX_HEIGHT_FIELD) are not configured.');
            }
            const itemSearch = search.create({
                type: search.Type.ITEM,
                filters: [['itemid', 'is', sku]],
                columns: [
                    search.createColumn({ name: BOX_WEIGHT_FIELD }),
                    search.createColumn({ name: BOX_LENGTH_FIELD }),
                    search.createColumn({ name: BOX_WIDTH_FIELD }),
                    search.createColumn({ name: BOX_HEIGHT_FIELD })
                ]
            });
            const results = itemSearch.run().getRange({ start: 0, end: 1 }) || [];
            if (!results.length) {
                throw new Error(`No NetSuite item found with itemid="${sku}" -- cannot determine box weight/dimensions.`);
            }

            const weight = Number(results[0].getValue({ name: BOX_WEIGHT_FIELD })) || 0;
            const length = Number(results[0].getValue({ name: BOX_LENGTH_FIELD })) || 0;
            const width = Number(results[0].getValue({ name: BOX_WIDTH_FIELD })) || 0;
            const height = Number(results[0].getValue({ name: BOX_HEIGHT_FIELD })) || 0;
            if (!weight || !length || !width || !height) {
                throw new Error(`Item "${sku}" is missing box weight/dimensions (weight=${weight}, length=${length}, width=${width}, height=${height}) -- cannot get a shipping rate.`);
            }
            return { weight, length, width, height };
        }

        /**
         * Maps Walmart's postalAddress shape (order details response) to the
         * contactName/addressLine1/... shape Ship With Walmart's APIs expect. Reuses
         * wm_mr_order_import.js's normalizeCountryCode() after all -- confirmed against
         * Walmart's own documented Create Label sample request that this API's country
         * field wants the 2-letter "US", same as NetSuite's own field, not the 3-letter
         * "USA" Walmart sends INBOUND in postalAddress.country. An earlier revision of
         * this file guessed "USA" was correct here without checking a real sample --
         * wrong, corrected now against Walmart's own documented example.
         */
        function buildWalmartAddress(postalAddress) {
            postalAddress = postalAddress || {};
            return {
                contactName: postalAddress.name,
                addressLine1: postalAddress.address1,
                addressLine2: postalAddress.address2,
                city: postalAddress.city,
                state: postalAddress.state,
                postalCode: postalAddress.postalCode,
                country: normalizeCountryCode(postalAddress.country),
                phone: postalAddress.phone
            };
        }

        /**
         * Collapses a buildWalmartAddress()-shaped address into one human-readable
         * line for customrecord_wal_shipping_notification (a single TEXT/LONGTEXT
         * field, not separate address fields) -- e.g. "Jane Doe, 123 Main St, Apt 4,
         * Springfield MA 01101, US". Skips any blank piece rather than leaving
         * awkward double-commas when e.g. addressLine2 is unset.
         */
        function formatShipToAddress(address) {
            if (!address) return null;
            const cityStateZip = [address.city, address.state, address.postalCode].filter(Boolean).join(' ');
            return [address.contactName, address.addressLine1, address.addressLine2, cityStateZip, address.country]
                .filter(Boolean)
                .join(', ');
        }

        /** Same US-normalization as wm_mr_order_import.js's normalizeCountryCode() -- duplicated here rather than shared, matching this project's convention. */
        function normalizeCountryCode(rawCountry) {
            const value = String(rawCountry || '').trim().toUpperCase();
            if (!value || value === 'USA' || value === 'US' || value === 'UNITED STATES' || value === 'UNITED STATES OF AMERICA') {
                return 'US';
            }
            return rawCountry;
        }

        /**
         * The Shipping Estimates API uses a DIFFERENT address shape than Create Label --
         * confirmed against Walmart's own separately documented sample requests for each
         * endpoint. Create Label wants postalCode/country/addressLine1/addressLine2/city/
         * state/contactName/phone; Shipping Estimates wants postalCode/countryCode/
         * addressLines (an ARRAY, not two separate line fields)/city/state, with no
         * contactName/phone at all. Converts a Create-Label-shaped address (either
         * TIREMATIC_FROM_ADDRESS or buildWalmartAddress()'s output) into the Estimates
         * shape, used only for calls to getShippingEstimates().
         */
        function toEstimatesAddress(address) {
            return {
                postalCode: address.postalCode,
                countryCode: address.country,
                addressLines: [address.addressLine1, address.addressLine2].filter(Boolean),
                city: address.city,
                state: address.state
            };
        }

        /**
         * Suitelet DATE fields come back from context.request.parameters as a plain
         * string in whatever date format this NetSuite user's preferences use (e.g.
         * "8/20/2026"), not something safely ISO-parseable directly -- N/format.parse()
         * is what correctly interprets that per NetSuite's own locale/format rules,
         * matching how a real Date value was actually entered on the form. Returns null
         * for a blank/unset field, matching Walmart's docs describing shipByDate/
         * deliverByDate as optional filters -- omitting them entirely if not provided,
         * rather than sending some fabricated placeholder date.
         */
        function parseDateFieldToIso(rawValue) {
            if (!rawValue) return null;
            const parsedDate = format.parse({ value: rawValue, type: format.Type.DATE });
            return parsedDate.toISOString();
        }

        /**
         * One orderLineStatus entry PER BOX, grouped by lineNumber -- a line whose
         * quantity spanned multiple boxes (multiple tires, same SKU) gets multiple
         * entries under that same lineNumber, each statusQuantity 1, each with that
         * specific box's own trackingInfo. Different from wm_ue_order_shipped.js's
         * shared-trackingInfo-per-line version, which assumed one shipment for the
         * whole order -- corrected here now that each box is its own real shipment.
         * methodCode read off the order's own shippingInfo, not derived from NetSuite.
         */
        function buildShipmentPayload(params) {
            const { orderDetails, labels, shipDateTime } = params;
            const methodCode = orderDetails.shippingInfo && orderDetails.shippingInfo.methodCode;

            const statusesByLineNumber = {};
            for (const { box, label } of labels) {
                if (!statusesByLineNumber[box.lineNumber]) statusesByLineNumber[box.lineNumber] = [];
                statusesByLineNumber[box.lineNumber].push({
                    status: 'Shipped',
                    statusQuantity: { unitOfMeasurement: 'EACH', amount: '1' },
                    trackingInfo: {
                        shipDateTime,
                        carrierName: { carrier: label.carrierName },
                        ...(methodCode ? { methodCode } : {}),
                        trackingNumber: label.trackingNo
                    }
                });
            }

            const shippedLines = Object.keys(statusesByLineNumber).map((lineNumber) => ({
                lineNumber,
                orderLineStatuses: { orderLineStatus: statusesByLineNumber[lineNumber] }
            }));

            return { orderShipment: { orderLines: { orderLine: shippedLines } } };
        }

        function getShippingEstimates(params) {
            const {
                accessToken, baseUrl, correlationId, environment, purchaseOrderId, boxDimensions, boxItems,
                fromAddress, toAddress, shipByDate, deliverByDate, includeServicesNotMeetingDeliveryPromise
            } = params;

            // includeServicesNotMeetingDeliveryPromise sent as an explicit FALSE (not just
            // omitted) whenever a deliverByDate is set -- asks Walmart to only return
            // options that actually meet the promise, so nothing needs filtering out of
            // the response afterward. Checked against false specifically (the only other
            // value the caller ever passes is null, meaning "no deliverByDate, omit this
            // field entirely") -- a plain truthy check would wrongly treat false the same
            // as "omit this field", since false is itself falsy.
            const requestBody = JSON.stringify({
                purchaseOrderId, packageType: 'CUSTOM_PACKAGE', boxDimensions, boxItems, fromAddress, toAddress,
                ...(shipByDate ? { shipByDate } : {}),
                ...(deliverByDate ? { deliverByDate } : {}),
                ...(includeServicesNotMeetingDeliveryPromise === false ? { includeServicesNotMeetingDeliveryPromise: false } : {})
            });
            log.audit(`Walmart shipping estimates request body (purchaseOrderId=${purchaseOrderId}, correlationId=${correlationId})`, requestBody);

            const response = https.post({
                url: `${baseUrl}/v3/shipping/labels/shipping-estimates`,
                body: requestBody,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'WM_QOS.CORRELATION_ID': correlationId,
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'WM_MARKET': 'us',
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            logHttpResponse(`Walmart shipping estimates request (purchaseOrderId=${purchaseOrderId})`, response, correlationId);
            if (response.code !== 200) {
                throw new Error(`Walmart shipping estimates request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }
            const parsed = safeJsonParse(response.body, correlationId, 'shipping estimates');
            // Trusting Walmart's own filtering here -- no client-side re-filter on
            // isDeliveryPromiseFulfilled anymore, since includeServicesNotMeetingDeliveryPromise:
            // false already asked it to only return qualifying options.
            return (parsed.data && parsed.data.estimates) || [];
        }

        function createLabel(params) {
            const { accessToken, baseUrl, correlationId, environment, purchaseOrderId, boxDimensions, boxItems, carrierName, carrierServiceType, fromAddress } = params;

            const requestBody = JSON.stringify({
                purchaseOrderId, packageType: 'CUSTOM_PACKAGE', boxDimensions, boxItems,
                carrierName, carrierServiceType, fromAddress
            });
            log.audit(`Walmart create label request body (purchaseOrderId=${purchaseOrderId}, correlationId=${correlationId})`, requestBody);

            const response = https.post({
                url: `${baseUrl}/v3/shipping/labels`,
                body: requestBody,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'WM_QOS.CORRELATION_ID': correlationId,
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'WM_MARKET': 'us',
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            logHttpResponse(`Walmart create label request (purchaseOrderId=${purchaseOrderId})`, response, correlationId);
            if (response.code !== 200) {
                throw new Error(`Walmart create label request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }
            const parsed = safeJsonParse(response.body, correlationId, 'create label');
            if (!parsed.data || !parsed.data.trackingNo) {
                throw new Error(`Walmart create label response missing tracking data (correlationId=${correlationId}): ${response.body}`);
            }
            return parsed.data;
        }

        /**
         * GET /v3/shipping/labels/carriers/{carrierShortName}/trackings/{trackingNo} --
         * confirmed via developer.walmart.com/us-marketplace/reference/getlabelbytrackingandcarrier:
         * returns the label as raw binary (PDF or PNG depending on Accept), no JSON
         * wrapper at all. Deliberately kept as a SEPARATE call from createLabel() rather
         * than trying to request "application/json,application/pdf" together on the
         * create-label call itself -- Walmart's own docs say a combined Accept header
         * picks ONE format by priority order, not both, and createLabel() already
         * reliably works today as JSON-only (trackingNo/carrierName are required
         * downstream); risking that by guessing at undocumented combined-header
         * behavior isn't worth it for a real, non-repeatable label purchase.
         */
        function getLabelFile(params) {
            const { accessToken, baseUrl, correlationId, environment, carrierShortName, trackingNo } = params;

            const response = https.get({
                url: `${baseUrl}/v3/shipping/labels/carriers/${encodeURIComponent(carrierShortName)}/trackings/${encodeURIComponent(trackingNo)}`,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'WM_QOS.CORRELATION_ID': correlationId,
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'WM_MARKET': 'us',
                    'Accept': 'application/pdf'
                }
            });

            logHttpResponse(`Walmart get label request (carrier=${carrierShortName}, trackingNo=${trackingNo})`, response, correlationId);
            if (response.code !== 200) {
                throw new Error(`Walmart get label request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }
            return response.body;
        }

        /**
         * Builds the label as an N/file File object, reads it back as base64 for the
         * inline data: URI preview, THEN saves it into LABEL_FOLDER_ID so the label is
         * actually persisted in the File Cabinet, not just shown once and discarded.
         * Goes through N/file's File object rather than hand-rolling base64 conversion
         * via N/encode -- NetSuite's own File object is what's actually built to
         * round-trip binary file types correctly (its getContents() returns base64 for
         * binary fileTypes), which is more trustworthy than guessing at N/encode/N/https's
         * handling of raw binary strings, an area with documented rough edges in the
         * NetSuite community. getContents() is read BEFORE save() deliberately, matching
         * the exact call order already confirmed working for the inline-preview-only
         * version of this function, rather than risking any behavior difference from
         * reading contents off an already-saved File object.
         */
        function saveLabelFile(pdfBytes, fileName) {
            const labelFile = file.create({
                name: fileName,
                fileType: file.Type.PDF,
                contents: pdfBytes,
                folder: LABEL_FOLDER_ID
            });
            const base64 = labelFile.getContents();
            const fileId = labelFile.save();
            return { dataUri: `data:application/pdf;base64,${base64}`, fileId };
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

        function acknowledgeOrder(params) {
            const { accessToken, baseUrl, purchaseOrderId, correlationId, environment } = params;

            const response = https.post({
                url: `${baseUrl}/v3/orders/${encodeURIComponent(purchaseOrderId)}/acknowledge`,
                body: '',
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'WM_QOS.CORRELATION_ID': correlationId,
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            logHttpResponse(`Walmart order acknowledge request (purchaseOrderId=${purchaseOrderId})`, response, correlationId);
            if (response.code !== 200) {
                // Confirmed live: Walmart rejects re-acknowledging a PO once part of it is
                // already Shipped/Cancelled ("Acknowledgment is not required for this
                // purchase order..."), not just once it's already Acknowledged -- acknowledge
                // is a whole-PO, one-time gate, so this happens on a SECOND visit to the same
                // PO after an earlier box was already confirmed shipped (partial/deferred
                // shipment, see header comment), even though other lines/quantities on it
                // aren't shipped yet. Not a real failure: swallowed rather than blocking the
                // rest of this box's shipment. Any other 400/error still throws as before.
                if (response.code === 400 && /acknowledgment is not required/i.test(response.body)) {
                    log.audit(`Walmart order acknowledge skipped -- already acknowledged/shipped (purchaseOrderId=${purchaseOrderId}, correlationId=${correlationId})`, response.body);
                    return null;
                }
                throw new Error(`Walmart order acknowledge request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }
            return safeJsonParse(response.body, correlationId, 'order acknowledge');
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

        function recordShipmentNotification(params) {
            const {
                purchaseOrderId, salesOrderId, status, trackingNumber, carrierName, sku, itemName,
                labelFileId, shipDate, correlationId, errorMessage, shippingMethod, rate, boxNumber,
                shippingAddress
            } = params;
            try {
                const notifRecord = record.create({ type: SHIP_NOTIFICATION_RECORD.TYPE, isDynamic: false });
                notifRecord.setValue({ fieldId: SHIP_NOTIFICATION_RECORD.FIELDS.PO_ID, value: String(purchaseOrderId) });
                notifRecord.setValue({ fieldId: SHIP_NOTIFICATION_RECORD.FIELDS.SALES_ORDER, value: salesOrderId });
                notifRecord.setValue({ fieldId: SHIP_NOTIFICATION_RECORD.FIELDS.STATUS, value: status });
                if (trackingNumber) notifRecord.setValue({ fieldId: SHIP_NOTIFICATION_RECORD.FIELDS.TRACKING, value: trackingNumber });
                if (carrierName) notifRecord.setValue({ fieldId: SHIP_NOTIFICATION_RECORD.FIELDS.CARRIER, value: carrierName });
                if (sku) notifRecord.setValue({ fieldId: SHIP_NOTIFICATION_RECORD.FIELDS.SKU, value: sku });
                if (itemName) notifRecord.setValue({ fieldId: SHIP_NOTIFICATION_RECORD.FIELDS.ITEM_NAME, value: itemName });
                if (labelFileId) notifRecord.setValue({ fieldId: SHIP_NOTIFICATION_RECORD.FIELDS.LABEL_FILE, value: labelFileId });
                if (shipDate) notifRecord.setValue({ fieldId: SHIP_NOTIFICATION_RECORD.FIELDS.SHIP_DATE, value: shipDate });
                if (correlationId) notifRecord.setValue({ fieldId: SHIP_NOTIFICATION_RECORD.FIELDS.CORRELATION, value: correlationId });
                if (errorMessage) notifRecord.setValue({ fieldId: SHIP_NOTIFICATION_RECORD.FIELDS.ERROR, value: String(errorMessage).substring(0, 1000) });
                if (SHIP_NOTIFICATION_RECORD.FIELDS.METHOD && shippingMethod) {
                    notifRecord.setValue({ fieldId: SHIP_NOTIFICATION_RECORD.FIELDS.METHOD, value: shippingMethod });
                }
                if (SHIP_NOTIFICATION_RECORD.FIELDS.RATE && rate != null && rate !== '') {
                    notifRecord.setValue({ fieldId: SHIP_NOTIFICATION_RECORD.FIELDS.RATE, value: `$${rate}` });
                }
                if (SHIP_NOTIFICATION_RECORD.FIELDS.BOX_NUMBER && boxNumber) {
                    notifRecord.setValue({ fieldId: SHIP_NOTIFICATION_RECORD.FIELDS.BOX_NUMBER, value: boxNumber });
                }
                if (SHIP_NOTIFICATION_RECORD.FIELDS.ADDRESS && shippingAddress) {
                    notifRecord.setValue({ fieldId: SHIP_NOTIFICATION_RECORD.FIELDS.ADDRESS, value: shippingAddress });
                }
                // Returned so handleBuyLabel() can bump this row's STATUS again later, once
                // shipment is ACTUALLY confirmed with Walmart -- see
                // markShipmentNotificationsConfirmed()'s comment for why that's a separate
                // step rather than setting the final status here.
                return notifRecord.save({ enableSourcing: false, ignoreMandatoryFields: true });
            } catch (recordError) {
                log.error('Failed to write shipment notification record', {
                    purchaseOrderId, salesOrderId, errorMessage: recordError && recordError.message
                });
                return null;
            }
        }

        /**
         * Bumps every already-created notification row's STATUS to its final "shipping
         * confirmed" text -- called ONLY after confirmShipmentAndUpdateSalesOrder()
         * actually succeeds. Needs to be a separate step, not part of
         * recordShipmentNotification()'s original write: that write happens PER BOX,
         * immediately after each label is bought/tracking is entered (so a later box's
         * failure never loses a label that was already purchased -- see header comment),
         * which is BEFORE the one shipment-confirmation call covering every box even
         * exists yet. Setting a "shipping confirmed" status at that earlier point would
         * simply be false if the confirmation call after the loop then failed. Best-effort
         * (like saveLabelFile()'s failure handling) -- by the time this runs, the real
         * shipment confirmation with Walmart already succeeded, so a failure here should
         * only be logged, never fail the already-successful result page.
         *
         * Picks the final status PER ENTRY (entry.manual) rather than taking one shared
         * status for the whole batch -- a single submission can freely mix Walmart-
         * purchased-label boxes and manual-tracking boxes, so each row needs its own
         * matching "...AND_SHIPPED" value.
         */
        function markShipmentNotificationsConfirmed(labels) {
            labels.forEach((entry) => {
                if (!entry.notifId) return; // recordShipmentNotification() itself already failed/logged this box
                const finalStatus = entry.manual
                    ? SHIP_NOTIFICATION_RECORD.STATUS.TRACKING_SUBMITTED_AND_SHIPPED
                    : SHIP_NOTIFICATION_RECORD.STATUS.LABEL_CREATED_AND_SHIPPED;
                try {
                    record.submitFields({
                        type: SHIP_NOTIFICATION_RECORD.TYPE, id: entry.notifId,
                        values: { [SHIP_NOTIFICATION_RECORD.FIELDS.STATUS]: finalStatus },
                        options: { enableSourcing: false, ignoreMandatoryFields: true }
                    });
                } catch (e) {
                    log.error('Failed to bump shipment notification to final confirmed status', {
                        notifId: entry.notifId, errorMessage: e && e.message
                    });
                }
            });
        }

        /** JSON.parse that logs the raw body before throwing -- same convention as the other Walmart scripts in this project. */
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
