/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Pulls Inventory Items (Class = Tire) from a NetSuite saved search, maps
 * them to the Walmart Marketplace Tires item spec, and uploads them via
 * the MP_ITEM feed API.
 *
 * Field list reconciled against the real Tires item spec (see
 * walmart-spec-output/Tires.json, pulled via POST /v3/items/spec with
 * feedType=MP_ITEM, version=5.0.20260608-18_15_07-api -- confirmed working
 * 2026-07-30 by scripts/fetch-walmart-item-spec.js). See its `required`
 * array for the 25 always-required fields, and its `allOf` block for fields
 * required conditionally:
 *   - tireType in {Passenger Car, Light Truck & SUV, Sport Utility Vehicle,
 *     Crossover & Minivan, Performance, Light Truck} Tires also requires
 *     tireLoadIndex, constructionType, tireAspectRatio, tireSpeedRating
 *   - tireType in {Passenger Car Tires, Light Truck Tires} also requires
 *     uniformTireQualityGrade
 *   - flotation_tire = "Yes" also requires tireAspectRatio
 *   - vehicleType in {Car, Light Truck, Sport Utility Vehicle} also
 *     requires tireTreadwearRating
 *   - vehicleType in {Car, Light Truck} also requires mileageWarranty
 *   - has_written_warranty = "Yes - Warranty Text" also requires warrantyText
 *   - has_written_warranty = "Yes - Warranty URL" also requires warrantyURL
 *   - isProp65WarningRequired = "Yes" also requires prop65WarningText
 *   - certification_type also drives some document-reference fields, not
 *     listed here -- irrelevant unless certification_type is ever set
 *
 * Script parameters:
 *   custscript_wal_tireupload_saved_search - internal ID of the tire item saved search
 *   custscript_wal_tireupload_client_id    - Walmart Marketplace API Client ID
 *   custscript_wal_tireupload_client_secret - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_tireupload_env          - "PRODUCTION" or "SANDBOX"
 *   custscript_wal_tireupload_bucket_size - TARGET items per bucket/feed submission (default 1000,
 *                                          Walmart's MP_ITEM feed max is 10,000 items, <=25MB
 *                                          recommended) -- NOT a bucket count; getNumBuckets() below
 *                                          divides the saved search's total row count (via a cheap
 *                                          count-only query, not a full materialization -- same
 *                                          approach as wm_mr_price_feed_upload.js) by this to compute
 *                                          how many buckets to hash into, so it self-scales as the
 *                                          catalog grows (replaces the old fixed
 *                                          custscript_wal_num_buckets count)
 *   custscript_wal_prop65_warning_text   - California Prop 65 warning text (Long Text field type;
 *                                          sent on every tire -- isProp65WarningRequired is hardcoded "Yes")
 *
 * RATE LIMIT: POST /v3/feeds?feedType=MP_ITEM is
 * limited to 10 requests/hour, on top of the 25MB/file recommendation.
 * Bucket COUNT is capped at MAX_BUCKETS_PER_HOUR (10) so a single run never
 * attempts more submissions than Walmart allows -- a catalog spike just
 * produces fewer, larger buckets instead. A submission that still 429s
 * anyway (e.g. another script or a manual resubmit used up the hour's
 * quota first) is logged as a reduce error, not silently lost.
 *
 * TODO: constructionType is hardcoded as 'Radial', this may change in the future
 *
 *
 */
define(['N/search', 'N/runtime', 'N/log', 'N/https', 'N/encode', 'N/record', 'N/crypto/random', 'N/cache'], (search, runtime, log, https, encode, record, random, cache) => {

    const BASE_URLS = {
        PRODUCTION: 'https://marketplace.walmartapis.com',
        SANDBOX: 'https://sandbox.walmartapis.com'
    };

    const FEED_TYPE = 'MP_ITEM';
    const WALMART_ITEM_TYPE = 'Tires';

    // ---------------------------------------------------------------------
    // Feed tracking -- Walmart feed processing is async (minutes to hours),
    // so each submitted feed's ID is persisted to this custom record for a
    // separate follow-up script to poll via getFeedStatus() later.
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

    // 1 hour -- long enough to cover one full M/R run without recomputing
    // the bucket count on every map() call.
    const BUCKET_CACHE_TTL_SECONDS = 3600;
    const BUCKET_CACHE_NAME = 'wal_tire_upload_buckets';

    // POST /v3/feeds?feedType=MP_ITEM is limited to 10 requests/hour,
    // one feed submission per bucket, so the bucket count
    // itself must never exceed this.
    const MAX_BUCKETS_PER_HOUR = 10;

    /**
     * Computes (and caches) how many buckets to hash items across, from a
     * CHEAP count-only query -- search.runPaged().count returns just the row
     * count, not the rows, avoiding the governance cost of materializing the
     * whole catalog in getInputData(). Cached via N/cache so map() isn't
     * re-running a search on every row: getInputData() populates it once via
     * the loader below; if the entry expires mid-run, a later map() call
     * just recomputes it rather than failing. Keyed by savedSearchId +
     * bucketSize so a stale value from a different search/bucket-size combo
     * is never reused.
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
                        + (computed < uncapped ? ` (capped from ${uncapped} -- raise custscript_wal_tireupload_bucket_size if buckets are getting too large)` : '')
                });
                return String(computed);
            }
        });
        return parseInt(value, 10);
    }

    // ---------------------------------------------------------------------
    // Item mapping: NetSuite Inventory Item -> Walmart MP_ITEM feed entry
    // ---------------------------------------------------------------------

    // Column identifiers map 1:1 to the Walmart schema key each feeds -- see
    // walmart-spec-output/tires-required-fields.js, the source-of-truth
    // mapping this was copied from. Fields still blank there stay blank here.
    const COLUMNS = {
        // Fields that feed the Orderable block (pricing, shipping,
        // identifiers -- generic across every product type).
        ORDERABLE: {
            SKU: 'itemid',
            PRODUCT_ID_UPC: 'custitemtire_upc',                 // tire UPC
            PRODUCT_ID_GTIN: 'upccode',                         // fallback when the tire has no UPC
            SHIPPING_WEIGHT: 'custitemproduct_ship_weight',
            COUNTRY_OF_ORIGIN: 'countryofmanufacture',          // TODO: missing for some, will be updated in netsuite
            PRICE: 'unitprice.pricing'
        },

        // Fields that feed Visible.Tires -- the product-type-specific
        // attributes shown on the item page and used for search/browse.
        VISIBLE: {
            PRODUCT_NAME: 'salesdescription',
            ASSEMBLED_PRODUCT_WEIGHT: 'custitem48',             // falls back to shipping weight
            TIRE_LOAD_INDEX: 'custitem_load_index',
            TIRE_SPEED_RATING: 'custitem_speed_rating',
            BRAND: 'custitem_inv_group',
            MANUFACTURER: 'manufacturer',
            MAIN_IMAGE_URL: 'custitem_scs_image_url',
            TIRE_TERRAIN: 'custitem_terrain_amani',
            TIRE_TYPE: 'custitem_tire_type_amani',              // raw values translated via TIRE_TYPE_FIELD_MAPPING below
            TIRE_WIDTH: 'custitem_ewd_raw_size_1',              // unit mm
            ASPECT_RATIO: 'custitem_ewd_raw_size_2',
            VEHICLE_TYPE: 'custitem_vehicle_category',          // raw values translated via VEHICLE_TYPE_MAPPING below
            WHEEL_DIAMETER: 'custitem_ewd_raw_size_3',          // unit in
            TIRE_HEIGHT: 'custitem_ewd_raw_size_4',             // unit in -- only used for LT-Metric sizing, see buildTireSizeString()
            IS_RUN_FLAT: 'custitem_tire_run_flat',

            TIRE_SIZE: 'custitem_tire_size_amani',              // TODO: tire size generation assumes 'Radial' construction. included as "Tire Size (Amani Site)" for some tires; built from buildTireSizeString() otherwise.
            DIMENSION_UNIT_TYPE: 'custitem_tire_dim_unit_type', // LT-Metric (IN) / P-Metrics (MM) -- drives buildTireSizeString()'s format
            GROUP: 'custitem_group',                            // model name (e.g. "Ragnarok GTS"), distinct from PRODUCT_NAME/salesdescription's full title -- used as buildShortDescription()'s subject
            TIRE_CLASS: 'custitem_tire_class',                  // LT/P/ST -- merged into tireType via TIRE_CLASS_TO_TIRE_TYPE below
            SECONDARY_IMAGE_FACE: 'CUSTITEM_PRODUCT_IMAGE_RECORD.custrecord_pil_face_jpg',
            SECONDARY_IMAGE_SIDE: 'CUSTITEM_PRODUCT_IMAGE_RECORD.custrecord_pil_side_jpg',
            
            // --- Conditionally-required fields (see TIRE_TYPES_REQUIRING_* /
            // VEHICLE_TYPES_REQUIRING_* above) -- only actually required on
            // items whose tireType/vehicleType triggers them (buildWalmartItem()).
            UNIFORM_TIRE_QUALITY_GRADE: 'custitemutqg',         // TODO: check formatting in netsuite. variety of values in netsuite eg.420A, 560AB, 320 A A, or in some cases a 6 digit number such as 653970
            TIRE_TREADWEAR_RATING: 'custitemutqg',              // numeric portion extracted via extractTreadwearNumber() below
            MILEAGE_WARRANTY: 'custitem_mileage_warranty',  

            
            MANUFACTURER_PART_NUMBER: 'itemid',
            TIRE_SEASON: 'custitem_tire_season',                     // Field added in NetSuite. Data only exists for some tires.             
            ELECTRIC_VEHICLE_TIRE: 'custitem_electric_vehicle_tire', // checkbox -- see mapCheckboxToYesNo()
            // has_written_warranty is hardcoded to "Yes - Warranty URL"

            // --- Unconfirmed placeholders -- no NetSuite field chosen yet ---
            WARRANTY_URL: ''                   // TODO: per-item warranty page URL -- each tire needs its own, not one shared URL

            // keyFeatures has no column -- always synthesized by
            // buildKeyFeatures(), never sourced from NetSuite.

            // flotation_tire and isProp65WarningRequired are hardcoded in
            // buildWalmartItem() -- see PROP65_WARNING_TEXT_PARAM below.
            // has_written_warranty is also hardcoded, but warrantyURL itself
            // is per-item -- see COLUMNS.VISIBLE.WARRANTY_URL above.
        }
    };

    // TODO: Prop65 warning text.
    // isProp65WarningRequired is hardcoded to "Yes" (see buildWalmartItem()),
    // which makes prop65WarningText required (Tires.json's allOf block). Not
    // tracked in NetSuite, so it's supplied via a script parameter instead --
    // create a Long Text parameter named custscript_wal_prop65_warning_text
    // on the script record (see file header).
    const PROP65_WARNING_TEXT_PARAM = 'custscript_wal_prop65_warning_text';

    // https://developer.walmart.com/us-marketplace/docs/item-spec-versioning-and-diff-reporting
    const FEED_SPEC_VERSION = '5.0.20260608-18_15_07-api'; 

    // ---------------------------------------------------------------------
    // Conditional-requirement trigger lists (Tires.json's allOf block) and
    // always-required field lists (schema root "required" arrays), used by
    // buildWalmartItem() to both populate and validate the built item.
    // See walmart-spec-output/conditionally-required-fields.js for the full
    // writeup of every condition and its current status.
    // ---------------------------------------------------------------------

    const TIRE_TYPES_REQUIRING_LOAD_SPEED_CONSTRUCTION = [
        'Crossover & Minivan Tires', 'Light Truck & SUV Tires', 'Light Truck Tires',
        'Passenger Car Tires', 'Performance Tires', 'Sport Utility Vehicle Tires'
    ];
    const TIRE_TYPES_REQUIRING_UNIFORM_QUALITY_GRADE = ['Light Truck Tires', 'Passenger Car Tires'];
    const VEHICLE_TYPES_REQUIRING_TREADWEAR_RATING = ['Car', 'Light Truck', 'Sport Utility Vehicle'];
    const VEHICLE_TYPES_REQUIRING_MILEAGE_WARRANTY = ['Car', 'Light Truck'];

    // custitem_tire_type_amani mixes two different Walmart concepts: a
    // vehicle-class category (tireType) and a tread/terrain style
    // (tireTerrain). Only 2 of the known raw values are an actual tireType --
    // the rest resolve to tireTerrain instead.
    const TIRE_TYPE_FIELD_MAPPING = {
        'Ultra High Performance (UHP)': { walmartField: 'tireType', values: ['Performance Tires'] },
        'Light Truck (LT)': { walmartField: 'tireType', values: ['Light Truck Tires'] },
        'Off-Road / All Terrain': { walmartField: 'tireTerrain', values: ['Off-Road', 'All-Terrain'] },
        'A/T': { walmartField: 'tireTerrain', values: ['All-Terrain'] },
        'M/T': { walmartField: 'tireTerrain', values: ['Mud Terrain'] },
        'X/T': { walmartField: 'tireTerrain', values: ['Off-Road'] }, // closest available -- no "extreme terrain" enum value
        'R/T': { walmartField: 'tireTerrain', values: ['Off-Road'] }  // closest available -- no "rugged terrain" enum value
    };

    // custitem_tire_class -> Walmart tireType enum. Merged into tireType
    // alongside whatever custitem_tire_type_amani's tags produce  e.g. a tire
    // tagged both 'Ultra High Performance (UHP)' and tireClass 'P' should end
    // up with BOTH 'Performance Tires' and 'Passenger Car Tires', since
    // Walmart's tireType is an array and a tire can legitimately be both.
    // Also catches cases like an LT-class tire whose custitem_tire_type_amani
    // tags are terrain-only (R/T, X/T, etc., all of which map to tireTerrain,
    // not tireType -- see TIRE_TYPE_FIELD_MAPPING above) and would otherwise
    // end up with an empty tireType despite tireClass saying LT.
    const TIRE_CLASS_TO_TIRE_TYPE = {
        'LT': 'Light Truck Tires',
        'P': 'Passenger Car Tires',
        'ST': 'Trailer Tires'
    };

    // custitem_vehicle_category -> array of Walmart vehicleType enum values.
    // Forged/Replica/Staggered/Tuner/"Tuner or Staggered" (wheel/rim-only
    // values) and Amani/Misc. (not vehicle types) are intentionally absent --
    // any of those seen on an item are silently dropped.
    const VEHICLE_TYPE_MAPPING = {
        'Car': ['Car'],
        'Passenger Car': ['Car'],
        'Classic Car': ['Car'],                              // no "Classic Car" in Walmart's enum
        'Car & SUV': ['Car', 'Sport Utility Vehicle'],
        'Car, Truck & SUV': ['Car', 'Light Truck', 'Sport Utility Vehicle'],
        'Truck & SUV': ['Light Truck', 'Sport Utility Vehicle'],
        'Dually': ['Light Truck'],                           // dual-rear-wheel pickup, closest fit
        'Offroad': ['Sport Utility Vehicle'],                // temporary mapping -- revisit
        'HC': ['Light Truck']                                // "Heavy Combination" -- no exact Walmart equivalent, best guess -- revisit if it causes validation issues
    };

    /**
     * Splits raw custitem_tire_type_amani values into actual Walmart
     * tireType values and "bonus" tireTerrain values, since some raw values
     * are really terrain descriptions rather than a vehicle-class category
     * (see TIRE_TYPE_FIELD_MAPPING). Unmapped raw values are dropped.
     * @param {string[]} rawValues
     * @returns {{tireType: string[], tireTerrain: string[]}}
     */
    function mapTireType(rawValues) {
        const tireTypeValues = [];
        const tireTerrainValues = [];
        rawValues.forEach((raw) => {
            const mapping = TIRE_TYPE_FIELD_MAPPING[raw];
            if (!mapping) return;
            const target = mapping.walmartField === 'tireTerrain' ? tireTerrainValues : tireTypeValues;
            target.push(...mapping.values);
        });
        return {
            tireType: Array.from(new Set(tireTypeValues)),
            tireTerrain: Array.from(new Set(tireTerrainValues))
        };
    }

    /**
     * Maps raw custitem_vehicle_category values to Walmart's vehicleType
     * enum, dropping anything unmapped (wheel/rim terms, brand names, etc.)
     * rather than guessing.
     * @param {string[]} rawValues
     * @returns {string[]}
     */
    function mapVehicleType(rawValues) {
        const mapped = rawValues.reduce((acc, raw) => acc.concat(VEHICLE_TYPE_MAPPING[raw] || []), []);
        return Array.from(new Set(mapped));
    }

    // custitem_terrain_amani -> Walmart tireTerrain enum
    // (All-Terrain/Highway Terrain/Ice/Mud Terrain/Off-Road/Sand/Snow).
    // Raw NetSuite text doesn't reliably already match Walmart's exact enum
    // spelling ("Street" has no Walmart equivalent name at all; "All Terrain"
    // is missing Walmart's hyphen) -- mapped explicitly rather than passed
    // through, same reasoning as VEHICLE_TYPE_MAPPING above.
    const TIRE_TERRAIN_MAPPING = {
        'Street': 'Highway Terrain',
        'Highway': 'Highway Terrain',
        'Highway Terrain': 'Highway Terrain',
        'Off-Road': 'Off-Road',
        'Off Road': 'Off-Road',
        'All Terrain': 'All-Terrain',
        'All-Terrain': 'All-Terrain',
        'Mud Terrain': 'Mud Terrain',
        'Mud': 'Mud Terrain',
        'Ice': 'Ice',
        'Sand': 'Sand',
        'Snow': 'Snow'
    };

    /**
     * Maps raw custitem_terrain_amani values to Walmart's tireTerrain enum
     * (see TIRE_TERRAIN_MAPPING above), dropping anything unmapped rather
     * than guessing or passing raw NetSuite text straight through -- e.g.
     * "Street" isn't a valid Walmart tireTerrain value on its own, unlike
     * "Off-Road" which happens to already match.
     * @param {string[]} rawValues
     * @returns {string[]}
     */
    function mapTireTerrain(rawValues) {
        const mapped = rawValues.reduce((acc, raw) => {
            const walmartValue = TIRE_TERRAIN_MAPPING[raw];
            return walmartValue ? acc.concat(walmartValue) : acc;
        }, []);
        return Array.from(new Set(mapped));
    }

    // ISO 3166-1 alpha-2 code -> Walmart's exact country_of_origin_substantial_
    // transformation enum spelling (_raw.json's closed list, 250 entries).
    // countryofmanufacture holds NetSuite's 2-letter code (e.g. "US"),this translates it. 
    // Most entries are the standard ISO English short name, but a handful of Walmart's spellings
    // are non-ISO-standard and must match EXACTLY or the feed fails schema
    // validation eg. "Cote d Ivoire" (no apostrophe), "Korea, North"/"Korea,
    // South" (not "North/South Korea"), "Viet Nam" (two words).
    const COUNTRY_CODE_TO_NAME = {
        AF: 'Afghanistan', AX: 'Aland Islands', AL: 'Albania', DZ: 'Algeria',
        AS: 'American Samoa', AD: 'Andorra', AO: 'Angola', AI: 'Anguilla',
        AQ: 'Antarctica', AG: 'Antigua and Barbuda', AR: 'Argentina', AM: 'Armenia',
        AW: 'Aruba', AU: 'Australia', AT: 'Austria', AZ: 'Azerbaijan',
        BS: 'Bahamas', BH: 'Bahrain', BD: 'Bangladesh', BB: 'Barbados',
        BY: 'Belarus', BE: 'Belgium', BZ: 'Belize', BJ: 'Benin',
        BM: 'Bermuda', BT: 'Bhutan', BO: 'Bolivia', BQ: 'Bonaire',
        BA: 'Bosnia and Herzegovina', BW: 'Botswana', BV: 'Bouvet Island', BR: 'Brazil',
        IO: 'British Indian Ocean Territory', BN: 'Brunei Darussalam', BG: 'Bulgaria', BF: 'Burkina Faso',
        BI: 'Burundi', KH: 'Cambodia', CM: 'Cameroon', CA: 'Canada',
        CV: 'Cape Verde', KY: 'Cayman Islands', CF: 'Central African Republic', TD: 'Chad',
        CL: 'Chile', CN: 'China', CX: 'Christmas Island', CC: 'Cocos (Keeling) Islands',
        CO: 'Colombia', KM: 'Comoros', CK: 'Cook Islands', CR: 'Costa Rica',
        CI: 'Cote d Ivoire', HR: 'Croatia', CU: 'Cuba', CW: 'Curacao',
        CY: 'Cyprus', CZ: 'Czech Republic', CD: 'Democratic Republic of the Congo', DK: 'Denmark',
        DJ: 'Djibouti', DM: 'Dominica', DO: 'Dominican Republic', EC: 'Ecuador',
        EG: 'Egypt', SV: 'El Salvador', GQ: 'Equatorial Guinea', ER: 'Eritrea',
        EE: 'Estonia', SZ: 'Eswatini', ET: 'Ethiopia', FK: 'Falkland Islands (Malvinas)',
        FO: 'Faroe Islands', FJ: 'Fiji', FI: 'Finland', FR: 'France',
        GF: 'French Guiana', PF: 'French Polynesia', TF: 'French Southern Territories', GA: 'Gabon',
        GM: 'Gambia', GE: 'Georgia', DE: 'Germany', GH: 'Ghana',
        GI: 'Gibraltar', GR: 'Greece', GL: 'Greenland', GD: 'Grenada',
        GP: 'Guadeloupe', GU: 'Guam', GT: 'Guatemala', GG: 'Guernsey',
        GN: 'Guinea', GW: 'Guinea-Bissau', GY: 'Guyana', HT: 'Haiti',
        HM: 'Heard Island & McDonald Isl', HN: 'Honduras', HK: 'Hong Kong', HU: 'Hungary',
        IS: 'Iceland', IN: 'India', ID: 'Indonesia', IR: 'Iran',
        IQ: 'Iraq', IE: 'Ireland', IM: 'Isle of Man', IL: 'Israel',
        IT: 'Italy', JM: 'Jamaica', JP: 'Japan', JE: 'Jersey',
        JO: 'Jordan', KZ: 'Kazakhstan', KE: 'Kenya', KI: 'Kiribati',
        KP: 'Korea, North', KR: 'Korea, South', XK: 'Kosovo', KW: 'Kuwait',
        KG: 'Kyrgyzstan', LA: 'Laos', LV: 'Latvia', LB: 'Lebanon',
        LS: 'Lesotho', LR: 'Liberia', LY: 'Libyan Arab Jamahiriya', LI: 'Liechtenstein',
        LT: 'Lithuania', LU: 'Luxembourg', MO: 'Macau', MK: 'Macedonia',
        MG: 'Madagascar', MW: 'Malawi', MY: 'Malaysia', MV: 'Maldives',
        ML: 'Mali', MT: 'Malta', MH: 'Marshall Islands', MQ: 'Martinique',
        MR: 'Mauritania', MU: 'Mauritius', YT: 'Mayotte', MX: 'Mexico',
        FM: 'Micronesia', MD: 'Moldova', MC: 'Monaco', MN: 'Mongolia',
        ME: 'Montenegro', MS: 'Montserrat', MA: 'Morocco', MZ: 'Mozambique',
        MM: 'Myanmar', NA: 'Namibia', NR: 'Nauru', NP: 'Nepal',
        NL: 'Netherlands', NC: 'New Caledonia', NZ: 'New Zealand', NI: 'Nicaragua',
        NE: 'Niger', NG: 'Nigeria', NU: 'Niue', NF: 'Norfolk Island',
        MP: 'Northern Mariana Islands', NO: 'Norway', OM: 'Oman', PK: 'Pakistan',
        PW: 'Palau', PS: 'Palestine', PA: 'Panama', PG: 'Papua New Guinea',
        PY: 'Paraguay', PE: 'Peru', PH: 'Philippines', PN: 'Pitcairn',
        PL: 'Poland', PT: 'Portugal', PR: 'Puerto Rico', QA: 'Qatar',
        CG: 'Republic of the Congo', RE: 'Reunion', RO: 'Romania', RU: 'Russian Federation',
        RW: 'Rwanda', BL: 'Saint Barthelemy', SH: 'Saint Helena', KN: 'Saint Kitts And Nevis',
        LC: 'Saint Lucia', SX: 'Saint Maarten', MF: 'Saint Martin', PM: 'Saint Pierre And Miquelon',
        VC: 'Saint Vincent & the Grenadines', WS: 'Samoa', SM: 'San Marino', ST: 'Sao Tome and Principe',
        SA: 'Saudi Arabia', SN: 'Senegal', RS: 'Serbia', SC: 'Seychelles',
        SL: 'Sierra Leone', SG: 'Singapore', SK: 'Slovakia', SI: 'Slovenia',
        SB: 'Solomon Islands', SO: 'Somalia', ZA: 'South Africa', GS: 'South Georgia/So Sandwich Isl',
        SS: 'South Sudan', ES: 'Spain', LK: 'Sri Lanka', SD: 'Sudan',
        SR: 'Suriname', SJ: 'Svalbard and Jan Mayen', SE: 'Sweden', CH: 'Switzerland',
        SY: 'Syrian Arab Republic', TW: 'Taiwan', TJ: 'Tajikistan', TZ: 'Tanzania',
        TH: 'Thailand', TL: 'Timor-Leste', TG: 'Togo', TK: 'Tokelau',
        TO: 'Tonga', TT: 'Trinidad and Tobago', TN: 'Tunisia', TR: 'Turkey',
        TM: 'Turkmenistan', TC: 'Turks and Caicos Islands', TV: 'Tuvalu', UG: 'Uganda',
        UA: 'Ukraine', AE: 'United Arab Emirates', GB: 'United Kingdom', US: 'United States',
        UY: 'Uruguay', UM: 'US Minor Outlying Islands', UZ: 'Uzbekistan', VU: 'Vanuatu',
        VA: 'Vatican City State', VE: 'Venezuela', VN: 'Viet Nam', VG: 'Virgin Islands (British)',
        VI: 'Virgin Islands (U.S.)', WF: 'Wallis and Futuna Islands', EH: 'Western Sahara', YE: 'Yemen',
        ZM: 'Zambia', ZW: 'Zimbabwe'
    };

    /**
     * Translates countryofmanufacture's raw 2-letter code into Walmart's exact
     * enum spelling (see COUNTRY_CODE_TO_NAME above). Case-insensitive since
     * NetSuite's raw value has been seen both upper- and lower-case. Returns
     * undefined for anything blank or unmapped so logMissingRequiredFields()
     * catches the gap instead of silently submitting a guessed country.
     * @param {string} rawCode
     * @returns {string|undefined}
     */
    function mapCountryOfOrigin(rawCode) {
        if (!rawCode) return undefined;
        return COUNTRY_CODE_TO_NAME[String(rawCode).trim().toUpperCase()];
    }

    /**
     * Extracts the leading numeric portion of a raw UTQG value (e.g.
     * "500AA" -> "500", "300 AB" -> "300", "320 A A" -> "320") for
     * tireTreadwearRating, which only accepts the bare numeric grade even though both are 
     * sourced from the same NetSuite field (custitemutqg, see COLUMNS.VISIBLE.UNIFORM_TIRE_
     * QUALITY_GRADE/TIRE_TREADWEAR_RATING above). 
     * @param {string} rawUtqg
     * @returns {string}
     */
    function extractTreadwearNumber(rawUtqg) {
        if (!rawUtqg) return '';
        const match = String(rawUtqg).trim().match(/^\d+/);
        return match ? match[0] : '';
    }

    // ---------------------------------------------------------------------
    // keyFeatures synthesis -- default bullets keyed by other Tires schema
    // fields the item already has. keyFeatures has no NetSuite source at
    // all, so these always drive buildKeyFeatures() below.
    // ---------------------------------------------------------------------

    const KEY_FEATURES_BY_TIRE_TYPE = {
        'Commercial Tires': 'Heavy-duty construction built to handle demanding commercial routes and daily loads',
        'Crossover & Minivan Tires': 'Balanced construction supports the extra weight of passengers and cargo with confidence',
        'Golf Tires': 'Wide tread design distributes weight evenly for gentle handling on grass and turf',
        'Lawn & Garden Tires': 'Aggressive turf tread grips grass, dirt, and gravel without tearing up your lawn',
        'Light Truck & SUV Tires': 'Rugged construction is built to handle towing, hauling, and off-road demands',
        'Light Truck Tires': 'Reinforced construction is built for towing, hauling, and heavy payloads',
        'Passenger Car Tires': 'Smooth, quiet ride tuned for everyday commuting and highway driving',
        'Performance Tires': 'Responsive handling and precise steering feedback for spirited driving',
        'Racing Tires': 'Ultra-high-speed-rated construction built for maximum performance on the track',
        'Sport Utility Vehicle Tires': 'Confident all-terrain traction handles pavement, gravel, and light off-road trails',
        'Temporary Spare Tire': 'Compact, space-saving design keeps your vehicle prepared for emergencies',
        'Touring Tires': 'Smooth, quiet ride designed for comfortable long-distance highway driving',
        'Trailer Tires': 'Reinforced sidewalls are built to handle the sway and stress of towing'
    };

    const KEY_FEATURES_BY_SPEED_RATING = {
        'A1': 'A1-rated for speeds up to 3 mph',
        'A2': 'A2-rated for speeds up to 6 mph',
        'A3': 'A3-rated for speeds up to 9 mph',
        'A4': 'A4-rated for speeds up to 12 mph',
        'A5': 'A5-rated for speeds up to 15 mph',
        'A6': 'A6-rated for speeds up to 18 mph',
        'A7': 'A7-rated for speeds up to 21 mph',
        'A8': 'A8-rated for speeds up to 24 mph',
        'B': 'B-rated for speeds up to 31 mph',
        'C': 'C-rated for speeds up to 37 mph',
        'D': 'D-rated for speeds up to 40 mph',
        'E': 'E-rated for speeds up to 43 mph',
        'F': 'F-rated for speeds up to 50 mph',
        'G': 'G-rated for speeds up to 56 mph',
        'J': 'J-rated for speeds up to 62 mph',
        'K': 'K-rated for speeds up to 68 mph',
        'L': 'L-rated for speeds up to 75 mph',
        'M': 'M-rated for speeds up to 81 mph',
        'N': 'N-rated for speeds up to 87 mph',
        'P': 'P-rated for speeds up to 93 mph',
        'Q': 'Q-rated for speeds up to 99 mph',
        'R': 'R-rated for speeds up to 106 mph',
        'S': 'S-rated for speeds up to 112 mph',
        'T': 'T-rated for speeds up to 118 mph',
        'U': 'U-rated for speeds up to 124 mph',
        'H': 'H-rated for speeds up to 130 mph',
        'V': 'V-rated for speeds up to 149 mph',
        'Z': 'Z-rated for speeds of 149+ mph',
        'ZR': 'ZR-rated for speeds of 149+ mph',
        'W': 'W-rated for speeds up to 168 mph',
        '(W)': '(W)-rated for speeds of 168+ mph',
        'Y': 'Y-rated for speeds up to 186 mph',
        '(Y)': '(Y)-rated for speeds of 186+ mph'
    };

    const KEY_FEATURES_BY_TIRE_TERRAIN = {
        'All-Terrain': 'All-Terrain tread design tackles pavement, gravel, and dirt with confidence',
        'Highway Terrain': 'Highway Terrain tread delivers a smooth, quiet ride built for daily pavement driving',
        'Ice': 'Specialized siping and compound bite into icy surfaces for dependable traction',
        'Mud Terrain': 'Aggressive Mud Terrain tread claws through deep mud and clears debris on the go',
        'Off-Road': 'Off-Road tread pattern is built to handle rocks, ruts, and rugged trails',
        'Sand': 'Tread design floats over loose sand instead of digging in and losing traction',
        'Snow': 'Snow-optimized tread and compound grip confidently in cold, slick conditions'
    };

    // Max load per index is the standard ETRTO/TRA tire load index chart
    // (single-tire load, lbs), sourced from Wikipedia's "Tire code" load index table.
    const KEY_FEATURES_BY_LOAD_INDEX = {
        '0': 'Load index 0 — rated to carry up to 99 lbs per tire',
        '1': 'Load index 1 — rated to carry up to 102 lbs per tire',
        '2': 'Load index 2 — rated to carry up to 105 lbs per tire',
        '3': 'Load index 3 — rated to carry up to 107 lbs per tire',
        '4': 'Load index 4 — rated to carry up to 110 lbs per tire',
        '5': 'Load index 5 — rated to carry up to 114 lbs per tire',
        '6': 'Load index 6 — rated to carry up to 117 lbs per tire',
        '7': 'Load index 7 — rated to carry up to 120 lbs per tire',
        '8': 'Load index 8 — rated to carry up to 123 lbs per tire',
        '9': 'Load index 9 — rated to carry up to 128 lbs per tire',
        '10': 'Load index 10 — rated to carry up to 132 lbs per tire',
        '11': 'Load index 11 — rated to carry up to 136 lbs per tire',
        '12': 'Load index 12 — rated to carry up to 139 lbs per tire',
        '13': 'Load index 13 — rated to carry up to 143 lbs per tire',
        '14': 'Load index 14 — rated to carry up to 148 lbs per tire',
        '15': 'Load index 15 — rated to carry up to 152 lbs per tire',
        '16': 'Load index 16 — rated to carry up to 157 lbs per tire',
        '17': 'Load index 17 — rated to carry up to 161 lbs per tire',
        '18': 'Load index 18 — rated to carry up to 165 lbs per tire',
        '19': 'Load index 19 — rated to carry up to 171 lbs per tire',
        '20': 'Load index 20 — rated to carry up to 176 lbs per tire',
        '21': 'Load index 21 — rated to carry up to 182 lbs per tire',
        '22': 'Load index 22 — rated to carry up to 187 lbs per tire',
        '23': 'Load index 23 — rated to carry up to 193 lbs per tire',
        '24': 'Load index 24 — rated to carry up to 198 lbs per tire',
        '25': 'Load index 25 — rated to carry up to 204 lbs per tire',
        '26': 'Load index 26 — rated to carry up to 209 lbs per tire',
        '27': 'Load index 27 — rated to carry up to 215 lbs per tire',
        '28': 'Load index 28 — rated to carry up to 220 lbs per tire',
        '29': 'Load index 29 — rated to carry up to 227 lbs per tire',
        '30': 'Load index 30 — rated to carry up to 234 lbs per tire',
        '31': 'Load index 31 — rated to carry up to 240 lbs per tire',
        '32': 'Load index 32 — rated to carry up to 247 lbs per tire',
        '33': 'Load index 33 — rated to carry up to 254 lbs per tire',
        '34': 'Load index 34 — rated to carry up to 260 lbs per tire',
        '35': 'Load index 35 — rated to carry up to 267 lbs per tire',
        '36': 'Load index 36 — rated to carry up to 276 lbs per tire',
        '37': 'Load index 37 — rated to carry up to 282 lbs per tire',
        '38': 'Load index 38 — rated to carry up to 291 lbs per tire',
        '39': 'Load index 39 — rated to carry up to 300 lbs per tire',
        '40': 'Load index 40 — rated to carry up to 309 lbs per tire',
        '41': 'Load index 41 — rated to carry up to 320 lbs per tire',
        '42': 'Load index 42 — rated to carry up to 331 lbs per tire',
        '43': 'Load index 43 — rated to carry up to 342 lbs per tire',
        '44': 'Load index 44 — rated to carry up to 353 lbs per tire',
        '45': 'Load index 45 — rated to carry up to 364 lbs per tire',
        '46': 'Load index 46 — rated to carry up to 375 lbs per tire',
        '47': 'Load index 47 — rated to carry up to 386 lbs per tire',
        '48': 'Load index 48 — rated to carry up to 397 lbs per tire',
        '49': 'Load index 49 — rated to carry up to 408 lbs per tire',
        '50': 'Load index 50 — rated to carry up to 419 lbs per tire',
        '51': 'Load index 51 — rated to carry up to 430 lbs per tire',
        '52': 'Load index 52 — rated to carry up to 441 lbs per tire',
        '53': 'Load index 53 — rated to carry up to 454 lbs per tire',
        '54': 'Load index 54 — rated to carry up to 467 lbs per tire',
        '55': 'Load index 55 — rated to carry up to 481 lbs per tire',
        '56': 'Load index 56 — rated to carry up to 494 lbs per tire',
        '57': 'Load index 57 — rated to carry up to 507 lbs per tire',
        '58': 'Load index 58 — rated to carry up to 520 lbs per tire',
        '59': 'Load index 59 — rated to carry up to 536 lbs per tire',
        '60': 'Load index 60 — rated to carry up to 551 lbs per tire',
        '61': 'Load index 61 — rated to carry up to 567 lbs per tire',
        '62': 'Load index 62 — rated to carry up to 584 lbs per tire',
        '63': 'Load index 63 — rated to carry up to 600 lbs per tire',
        '64': 'Load index 64 — rated to carry up to 617 lbs per tire',
        '65': 'Load index 65 — rated to carry up to 639 lbs per tire',
        '66': 'Load index 66 — rated to carry up to 661 lbs per tire',
        '67': 'Load index 67 — rated to carry up to 677 lbs per tire',
        '68': 'Load index 68 — rated to carry up to 694 lbs per tire',
        '69': 'Load index 69 — rated to carry up to 716 lbs per tire',
        '70': 'Load index 70 — rated to carry up to 739 lbs per tire',
        '71': 'Load index 71 — rated to carry up to 761 lbs per tire',
        '72': 'Load index 72 — rated to carry up to 783 lbs per tire',
        '73': 'Load index 73 — rated to carry up to 805 lbs per tire',
        '74': 'Load index 74 — rated to carry up to 827 lbs per tire',
        '75': 'Load index 75 — rated to carry up to 852 lbs per tire',
        '76': 'Load index 76 — rated to carry up to 882 lbs per tire',
        '77': 'Load index 77 — rated to carry up to 908 lbs per tire',
        '78': 'Load index 78 — rated to carry up to 937 lbs per tire',
        '79': 'Load index 79 — rated to carry up to 963 lbs per tire',
        '80': 'Load index 80 — rated to carry up to 992 lbs per tire',
        '81': 'Load index 81 — rated to carry up to 1,019 lbs per tire',
        '82': 'Load index 82 — rated to carry up to 1,047 lbs per tire',
        '83': 'Load index 83 — rated to carry up to 1,074 lbs per tire',
        '84': 'Load index 84 — rated to carry up to 1,102 lbs per tire',
        '85': 'Load index 85 — rated to carry up to 1,135 lbs per tire',
        '86': 'Load index 86 — rated to carry up to 1,168 lbs per tire',
        '87': 'Load index 87 — rated to carry up to 1,201 lbs per tire',
        '88': 'Load index 88 — rated to carry up to 1,235 lbs per tire',
        '89': 'Load index 89 — rated to carry up to 1,279 lbs per tire',
        '90': 'Load index 90 — rated to carry up to 1,323 lbs per tire',
        '91': 'Load index 91 — rated to carry up to 1,356 lbs per tire',
        '92': 'Load index 92 — rated to carry up to 1,389 lbs per tire',
        '93': 'Load index 93 — rated to carry up to 1,433 lbs per tire',
        '94': 'Load index 94 — rated to carry up to 1,477 lbs per tire',
        '95': 'Load index 95 — rated to carry up to 1,521 lbs per tire',
        '96': 'Load index 96 — rated to carry up to 1,565 lbs per tire',
        '97': 'Load index 97 — rated to carry up to 1,609 lbs per tire',
        '98': 'Load index 98 — rated to carry up to 1,653 lbs per tire',
        '99': 'Load index 99 — rated to carry up to 1,709 lbs per tire',
        '100': 'Load index 100 — rated to carry up to 1,764 lbs per tire',
        '101': 'Load index 101 — rated to carry up to 1,819 lbs per tire',
        '102': 'Load index 102 — rated to carry up to 1,874 lbs per tire',
        '103': 'Load index 103 — rated to carry up to 1,929 lbs per tire',
        '104': 'Load index 104 — rated to carry up to 1,984 lbs per tire',
        '105': 'Load index 105 — rated to carry up to 2,039 lbs per tire',
        '106': 'Load index 106 — rated to carry up to 2,094 lbs per tire',
        '107': 'Load index 107 — rated to carry up to 2,149 lbs per tire',
        '108': 'Load index 108 — rated to carry up to 2,205 lbs per tire',
        '109': 'Load index 109 — rated to carry up to 2,271 lbs per tire',
        '110': 'Load index 110 — rated to carry up to 2,337 lbs per tire',
        '111': 'Load index 111 — rated to carry up to 2,403 lbs per tire',
        '112': 'Load index 112 — rated to carry up to 2,469 lbs per tire',
        '113': 'Load index 113 — rated to carry up to 2,535 lbs per tire',
        '114': 'Load index 114 — rated to carry up to 2,601 lbs per tire',
        '115': 'Load index 115 — rated to carry up to 2,679 lbs per tire',
        '116': 'Load index 116 — rated to carry up to 2,756 lbs per tire',
        '117': 'Load index 117 — rated to carry up to 2,833 lbs per tire',
        '118': 'Load index 118 — rated to carry up to 2,910 lbs per tire',
        '119': 'Load index 119 — rated to carry up to 2,998 lbs per tire',
        '120': 'Load index 120 — rated to carry up to 3,086 lbs per tire',
        '121': 'Load index 121 — rated to carry up to 3,197 lbs per tire',
        '122': 'Load index 122 — rated to carry up to 3,307 lbs per tire',
        '123': 'Load index 123 — rated to carry up to 3,417 lbs per tire',
        '124': 'Load index 124 — rated to carry up to 3,527 lbs per tire',
        '125': 'Load index 125 — rated to carry up to 3,638 lbs per tire',
        '126': 'Load index 126 — rated to carry up to 3,748 lbs per tire',
        '127': 'Load index 127 — rated to carry up to 3,858 lbs per tire',
        '128': 'Load index 128 — rated to carry up to 3,968 lbs per tire',
        '129': 'Load index 129 — rated to carry up to 4,079 lbs per tire',
        '130': 'Load index 130 — rated to carry up to 4,189 lbs per tire',
        '131': 'Load index 131 — rated to carry up to 4,289 lbs per tire',
        '132': 'Load index 132 — rated to carry up to 4,409 lbs per tire',
        '133': 'Load index 133 — rated to carry up to 4,541 lbs per tire',
        '134': 'Load index 134 — rated to carry up to 4,674 lbs per tire',
        '135': 'Load index 135 — rated to carry up to 4,806 lbs per tire',
        '136': 'Load index 136 — rated to carry up to 4,938 lbs per tire',
        '137': 'Load index 137 — rated to carry up to 5,071 lbs per tire',
        '138': 'Load index 138 — rated to carry up to 5,203 lbs per tire',
        '139': 'Load index 139 — rated to carry up to 5,357 lbs per tire',
        '140': 'Load index 140 — rated to carry up to 5,512 lbs per tire',
        '141': 'Load index 141 — rated to carry up to 5,677 lbs per tire',
        '142': 'Load index 142 — rated to carry up to 5,842 lbs per tire',
        '143': 'Load index 143 — rated to carry up to 6,008 lbs per tire',
        '144': 'Load index 144 — rated to carry up to 6,173 lbs per tire',
        '145': 'Load index 145 — rated to carry up to 6,393 lbs per tire',
        '146': 'Load index 146 — rated to carry up to 6,614 lbs per tire',
        '147': 'Load index 147 — rated to carry up to 6,779 lbs per tire',
        '148': 'Load index 148 — rated to carry up to 6,844 lbs per tire',
        '149': 'Load index 149 — rated to carry up to 7,165 lbs per tire',
        '150': 'Load index 150 — rated to carry up to 7,390 lbs per tire',
        '152': 'Load index 152 — rated to carry up to 7,830 lbs per tire',
        '156': 'Load index 156 — rated to carry up to 8,820 lbs per tire',
        '160': 'Load index 160 — rated to carry up to 9,920 lbs per tire'
    };

    const KEY_FEATURES_BY_TIRE_SEASON = {
        'All-Season': 'All-Season tread compound delivers confident grip year-round in wet and dry conditions',
        'Summer': 'Summer tread compound maximizes grip and handling in warm, dry conditions',
        'Winter': 'Winter tread compound and biting edges grip confidently in snow, ice, and cold temperatures'
    };

    // Only worth calling out as a "feature" when the tire actually is run-flat.
    const RUN_FLAT_KEY_FEATURE = 'Run-flat technology keeps you moving at reduced speed for up to 10 miles after a puncture';

    // Generic fallback bullets, used to pad keyFeatures toward the schema's
    // minItems = 5 when too few of the lookups above matched (e.g. an item
    // missing tireType/tireTerrain/speedRating/loadIndex/season/runFlat
    // data). Kept in the quality/compliance/install/durability/trust space
    // so they don't overlap the specific lookups above (ride comfort,
    // handling, tread, max speed, max load, weather grip, puncture safety).
    const GENERIC_KEY_FEATURES = [
        'Precision-engineered construction delivers consistent, dependable performance mile after mile',
        'Manufactured to meet strict DOT safety and quality standards',
        'Every tire is quality-inspected before it leaves the factory',
        'Straightforward mounting and balancing at any professional tire shop',
        'Built with durable materials designed to stand up to daily wear',
        'A dependable choice trusted by drivers for everyday performance'
    ];

    /**
     * Synthesizes keyFeatures bullets from other schema fields the item
     * already has. One bullet per matching lookup, deduplicated, then padded
     * with GENERIC_KEY_FEATURES (in order) toward the schema's minItems = 5
     * if too few of the specific lookups matched.
     * @param {Object} fields
     * @param {string[]} fields.tireType - translated (Walmart enum) values
     * @param {string[]} fields.tireTerrain - translated (Walmart enum) values
     * @param {string} fields.tireSpeedRating
     * @param {string} fields.tireLoadIndex
     * @param {string} fields.tireSeason
     * @param {string} fields.isRunFlat
     * @returns {string[]}
     */
    function buildKeyFeatures(fields) {
        const bullets = [];
        fields.tireType.forEach((t) => { if (KEY_FEATURES_BY_TIRE_TYPE[t]) bullets.push(KEY_FEATURES_BY_TIRE_TYPE[t]); });
        fields.tireTerrain.forEach((t) => { if (KEY_FEATURES_BY_TIRE_TERRAIN[t]) bullets.push(KEY_FEATURES_BY_TIRE_TERRAIN[t]); });
        if (KEY_FEATURES_BY_SPEED_RATING[fields.tireSpeedRating]) bullets.push(KEY_FEATURES_BY_SPEED_RATING[fields.tireSpeedRating]);
        if (KEY_FEATURES_BY_LOAD_INDEX[fields.tireLoadIndex]) bullets.push(KEY_FEATURES_BY_LOAD_INDEX[fields.tireLoadIndex]);
        if (KEY_FEATURES_BY_TIRE_SEASON[fields.tireSeason]) bullets.push(KEY_FEATURES_BY_TIRE_SEASON[fields.tireSeason]);
        if (fields.isRunFlat === 'Yes') bullets.push(RUN_FLAT_KEY_FEATURE);

        const deduped = Array.from(new Set(bullets));
        for (let i = 0; deduped.length < 5 && i < GENERIC_KEY_FEATURES.length; i++) {
            if (!deduped.includes(GENERIC_KEY_FEATURES[i])) deduped.push(GENERIC_KEY_FEATURES[i]);
        }
        return deduped;
    }

    // ---------------------------------------------------------------------
    // shortDescription synthesis. 
    // A generated paragraph built from the item's own translated attribute values.
    // ---------------------------------------------------------------------

    // Generic filler sentences for buildShortDescription() -- deliberately
    // distinct wording from keyFeatures' lookups/GENERIC_KEY_FEATURES above,
    // used to pad buildShortDescription() toward the 60-word minimum when an
    // item's attributes don't produce enough sentences on their own.
    const GENERIC_DESCRIPTION_FILLERS = [
        'Every tire is engineered with precision and backed by rigorous quality control, so it performs consistently mile after mile.',
        'It meets strict DOT safety standards and is inspected before it ever leaves the factory.',
        'Mounting and balancing are quick and straightforward at any professional tire shop.',
        'Durable materials and dependable construction help it stand up to daily wear and tear.',
        'It is a trusted choice for drivers who expect reliable performance without surprises.'
    ];

    /** Word count, splitting on any run of whitespace. */
    function countWords(text) {
        return String(text || '').trim().split(/\s+/).filter(Boolean).length;
    }

    /** Joins a string array as a natural-language list ("a, b, and c"). */
    function joinWithAnd(items) {
        if (items.length === 0) return '';
        if (items.length === 1) return items[0];
        if (items.length === 2) return `${items[0]} and ${items[1]}`;
        return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
    }

    const VEHICLE_TYPE_PLURAL = {
        'Car': 'cars',
        'Light Truck': 'light trucks',
        'Sport Utility Vehicle': 'SUVs'
    };

    /** "a" before a consonant sound, "an" before a vowel sound (e.g. "an all-season", "a summer"). */
    function article(word) {
        return /^[aeiou]/i.test(word || '') ? 'an' : 'a';
    }

    /** Deterministic (non-cryptographic) string hash -- same SKU always yields the same variety picks. */
    function hashString(str) {
        let hash = 0;
        const s = String(str || '');
        for (let i = 0; i < s.length; i++) {
            hash = (hash * 31 + s.charCodeAt(i)) & 0x7fffffff;
        }
        return hash;
    }

    /** Seeded Fisher-Yates shuffle -- deterministic per seed, not true randomness, so re-running the same item reproduces the same order. */
    function seededShuffle(array, seed) {
        const arr = array.slice();
        let state = seed || 1;
        const next = () => {
            state = (state * 1103515245 + 12345) & 0x7fffffff;
            return state;
        };
        for (let i = arr.length - 1; i > 0; i--) {
            const j = next() % (i + 1);
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    /** Thousands-separator formatting (e.g. 60000 -> "60,000") without depending on toLocaleString()'s locale behavior. */
    function formatNumber(n) {
        return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    // Multiple phrasings so a batch of items doesn't repeat the exact
    // same mileage-warranty sentence -- picked deterministically per
    // item (see buildShortDescription()'s seed), not randomly.
    const MILEAGE_WARRANTY_SENTENCES = [
        (miles) => `Backed by a ${miles}-mile treadwear warranty.`,
        (miles) => `A ${miles}-mile treadwear warranty backs it for the long haul.`,
        (miles) => `Its treadwear warranty covers up to ${miles} miles.`
    ];

    // Multiple closing-flourish phrasings (only used when fields.group
    // is present).
    const CLOSING_LINE_SENTENCES = [
        (group) => `Built with the latest tire technology, the ${group} delivers performance you can rely on mile after mile.`,
        (group) => `From daily commutes to demanding drives, the ${group} is engineered to perform when it matters most.`,
        (group) => `The ${group} combines proven engineering with dependable materials for a tire you can trust.`,
        (group) => `Backed by rigorous engineering, the ${group} is built to deliver consistent performance for the long haul.`,
        (group) => `Whatever the road ahead, the ${group} is built to get you there with confidence.`
    ];

    // tireType, tireSpeedRating, tireLoadIndex, and isRunFlat all also drive a
    // buildKeyFeatures() bullet (see above) -- KEY_FEATURES_BY_TIRE_TYPE/
    // SPEED_RATING/LOAD_INDEX/RUN_FLAT_KEY_FEATURE stay in scope here only as the
    // SOURCE of the underlying fact (the type label, the mph number, the lbs
    // number), never rendered verbatim into the description. Each gets its own
    // shortDescription-only phrasing below, on a different angle (use-case/
    // benefit) than the keyFeatures bullet's angle (construction/spec), so a
    // reviewer reading both for the same item sees two takes on the fact, not
    // the same sentence twice.

    // Same use-case framing as KEY_FEATURES_BY_TIRE_TYPE's keys, worded as
    // benefit-facing prose instead of that table's construction/engineering
    // framing.
    const SHORT_DESC_TIRE_TYPE_SENTENCES = {
        'Commercial Tires': "It's built for commercial-route duty, standing up to daily loads without missing a beat.",
        'Crossover & Minivan Tires': "It's tuned for crossover and minivan use, handling the extra weight of passengers and cargo with ease.",
        'Golf Tires': "It's designed for the golf course, spreading weight evenly so it won't tear up the turf.",
        'Lawn & Garden Tires': "It's suited for lawn and garden equipment, gripping grass and gravel without chewing up your yard.",
        'Light Truck & SUV Tires': "It's suited to light-truck and SUV duty, from towing and hauling to the occasional dirt road.",
        'Light Truck Tires': "It's built for light-truck work, standing up to towing and heavy payloads.",
        'Passenger Car Tires': "It's tuned for everyday passenger-car driving, commuting and highway miles alike.",
        'Performance Tires': "It's tuned for performance driving, with sharp steering feedback when you push it.",
        'Racing Tires': "It's built for the track, engineered around ultra-high-speed performance.",
        'Sport Utility Vehicle Tires': "It's suited to SUV duty, handling pavement, gravel, and the occasional light trail.",
        'Temporary Spare Tire': "It's a compact spare, made to get you safely to a shop rather than for daily driving.",
        'Touring Tires': "It's tuned for touring, built for long highway stretches in comfort and quiet.",
        'Trailer Tires': "It's built for trailer duty, with sidewalls reinforced against the sway and stress of towing."
    };

    // Benefit-facing counterpart to RUN_FLAT_KEY_FEATURE's spec-facing bullet.
    const SHORT_DESC_RUN_FLAT_SENTENCE = "It's also run-flat rated, so a puncture won't leave you stranded roadside.";

    /** Pulls the mph number (and whether it's an open-ended "149+" style rating) out of a KEY_FEATURES_BY_SPEED_RATING sentence. */
    function parseSpeedRatingMph(sentence) {
        const match = /(\d+)(\+)?\s*mph/.exec(sentence || '');
        return match ? { mph: match[1], plus: !!match[2] } : null;
    }

    /** Pulls the "lbs per tire" number out of a KEY_FEATURES_BY_LOAD_INDEX sentence. */
    function parseLoadIndexLbs(sentence) {
        const match = /up to ([\d,]+) lbs/.exec(sentence || '');
        return match ? match[1] : null;
    }

    // Multiple phrasings so a batch of items with the same rating doesn't read
    // as the same sentence with only the number changed -- same reasoning/
    // seeding as MILEAGE_WARRANTY_SENTENCES above.
    const SPEED_RATING_SHORT_DESC_SENTENCES = [
        (letter, mph, plus) => (plus
            ? `Its ${letter} speed rating certifies it for sustained speeds of ${mph}+ mph.`
            : `Its ${letter} speed rating certifies it for sustained speeds up to ${mph} mph.`),
        (letter, mph, plus) => (plus
            ? `With a ${letter} speed rating, it's built to handle sustained speeds beyond ${mph} mph.`
            : `With a ${letter} speed rating, it's built to safely handle speeds up to ${mph} mph.`)
    ];

    const LOAD_INDEX_SHORT_DESC_SENTENCES = [
        (lbs) => `It carries a load index rated to support up to ${lbs} lbs per tire.`,
        (lbs) => `Its load index supports up to ${lbs} lbs per tire, so it won't be the weak link under load.`
    ];

    /**
     * Synthesizes a Walmart-compliant shortDescription paragraph from the
     * item's translated tireType/tireTerrain/vehicleType/etc.
     *
     * Modeled on real tire-retailer copy (e.g. "The LXHT-206 from Lexani
     * is an all-season, highway terrain tire that's designed for use on
     * light trucks and SUVs...") rather than a flat list of independent
     * feature bullets -- season and terrain are folded into the intro
     * sentence as adjectives instead of getting their own KEY_FEATURES_BY_*
     * sentence, since naming "all-season" up front and then separately
     * stating "All-Season tread compound delivers..." later is redundant.
     * tireType still gets its own sentence since it speaks to a different
     * angle (structural purpose, e.g. towing/hauling) rather than
     * restating season/terrain.
     *
     * Detail-sentence order is shuffled and the mileage-warranty/closing-
     * line phrasing is picked from a small pool -- both seeded by
     * fields.sku (see hashString()/seededShuffle()) -- so a batch of items
     * doesn't read as the same template with different numbers swapped
     * in. Seeding by sku rather than group means sibling sizes of the
     * same model line still vary from each other.
     * @param {Object} fields
     * @param {string} fields.sku - used only to seed the deterministic
     *   variety picks below, not part of the description itself.
     * @param {string} fields.group - model name (e.g. "Ragnarok GTS"),
     *   distinct from productName's full title -- preferred as the
     *   description's subject when present.
     * @returns {string}
     */
    function buildShortDescription(fields) {
        const seed = hashString(fields.sku || fields.group || fields.productName || fields.brand);

        const primaryTireType = fields.tireType[0];
        const primaryTireTerrain = fields.tireTerrain[0];

        const seasonAdj = fields.tireSeason ? fields.tireSeason.toLowerCase() : '';
        const terrainAdj = primaryTireTerrain ? primaryTireTerrain.toLowerCase() : '';
        const descriptors = [seasonAdj, terrainAdj].filter(Boolean).join(', ');
        const tireNoun = descriptors ? `${descriptors} tire` : 'tire';

        const vehicleText = fields.vehicleType.length
            ? joinWithAnd(fields.vehicleType.map((v) => VEHICLE_TYPE_PLURAL[v] || v.toLowerCase()))
            : '';
        const useClause = vehicleText ? ` that's designed for use on ${vehicleText}` : '';

        // group (model name, e.g. "Ragnarok GTS") is preferred over productName
        // (salesdescription's full title, e.g. "Venom Power 245/35ZR20 95W XL
        // Ragnarok GTS") -- a model name reads naturally as a sentence subject
        // the way a full title doesn't. No trailing "tire" on the brandSize/bare
        // fallbacks -- tireNoun below already ends in "tire" ("...is a/an [x]
        // tire"), so appending it here too would read as "This tire is a tire."
        const brandSize = [fields.brand, fields.tireSize].filter(Boolean).join(' ');
        const subject = fields.group
            ? (fields.brand ? `The ${fields.group} from ${fields.brand}` : `The ${fields.group}`)
            : (fields.productName || (brandSize ? `The ${brandSize}` : 'This'));

        const introSentence = `${subject} is ${article(descriptors || 'tire')} ${tireNoun}${useClause}.`;

        // Model is already named in the intro sentence, so these detail
        // sentences use "It"/"It's" like normal prose, not the model name
        // again every time (real tire-retailer copy names the model up
        // front, then once more as a closing flourish at the very end 
        // but not on every fact sentence in between).
        // Collected into a pool and shuffled below rather than appended
        // in this fixed order.
        //
        // tireType/tireSpeedRating/tireLoadIndex/isRunFlat each use their
        // SHORT_DESC_*/*_SHORT_DESC_SENTENCES phrasing here, NOT the
        // KEY_FEATURES_BY_*/RUN_FLAT_KEY_FEATURE text -- buildKeyFeatures()
        // already turns those same facts into keyFeatures bullets, and this
        // item's keyFeatures + shortDescription are shown to a reviewer
        // together, so reusing that exact wording here would read as the same
        // sentence twice. See the comment above SHORT_DESC_TIRE_TYPE_SENTENCES.
        const detailSentences = [];
        if (SHORT_DESC_TIRE_TYPE_SENTENCES[primaryTireType]) detailSentences.push(SHORT_DESC_TIRE_TYPE_SENTENCES[primaryTireType]);
        const speedRatingMph = parseSpeedRatingMph(KEY_FEATURES_BY_SPEED_RATING[fields.tireSpeedRating]);
        if (speedRatingMph) {
            const speedSentence = SPEED_RATING_SHORT_DESC_SENTENCES[(seed + 3) % SPEED_RATING_SHORT_DESC_SENTENCES.length];
            detailSentences.push(speedSentence(fields.tireSpeedRating, speedRatingMph.mph, speedRatingMph.plus));
        }
        const loadIndexLbs = parseLoadIndexLbs(KEY_FEATURES_BY_LOAD_INDEX[fields.tireLoadIndex]);
        if (loadIndexLbs) {
            const loadSentence = LOAD_INDEX_SHORT_DESC_SENTENCES[(seed + 5) % LOAD_INDEX_SHORT_DESC_SENTENCES.length];
            detailSentences.push(loadSentence(loadIndexLbs));
        }
        if (fields.isRunFlat === 'Yes') detailSentences.push(SHORT_DESC_RUN_FLAT_SENTENCE);
        if (fields.uniformTireQualityGrade) detailSentences.push(`It carries a UTQG rating of ${fields.uniformTireQualityGrade} for treadwear, traction, and temperature resistance.`);
        if (fields.mileageWarrantyMeasure) {
            const mileageSentence = MILEAGE_WARRANTY_SENTENCES[(seed + 7) % MILEAGE_WARRANTY_SENTENCES.length];
            detailSentences.push(mileageSentence(formatNumber(fields.mileageWarrantyMeasure)));
        }

        const sentences = [introSentence, ...seededShuffle(detailSentences, seed)];

        let filler = 0;
        while (countWords(sentences.join(' ')) < 60 && filler < GENERIC_DESCRIPTION_FILLERS.length) {
            sentences.push(GENERIC_DESCRIPTION_FILLERS[filler]);
            filler++;
        }

        // Closing bookend -- names the model once more at the very end,
        // mirroring how real tire-retailer copy wraps up ("...have produced
        // the Lexani Terrain Beast incorporating the very latest
        // technology...") rather than only naming it up front.
        if (fields.group) {
            const closingSentence = CLOSING_LINE_SENTENCES[(seed + 13) % CLOSING_LINE_SENTENCES.length];
            sentences.push(closingSentence(fields.group));
        }

        return sentences.join(' ');
    }

    const ALWAYS_REQUIRED_ORDERABLE_FIELDS = [
        'sku', 'productIdentifiers', 'price', 'ShippingWeight',
        'country_of_origin_substantial_transformation'
    ];
    const ALWAYS_REQUIRED_VISIBLE_FIELDS = [
        'productName', 'brand', 'condition', 'shortDescription', 'keyFeatures', 'mainImageUrl',
        'productSecondaryImageURL', 'count', 'multipackQuantity', 'isProp65WarningRequired',
        'assembledProductWeight', 'electric_vehicle_tire', 'flotation_tire', 'has_written_warranty',
        'isRunFlat', 'manufacturer', 'manufacturerPartNumber', 'netContent', 'tireSeason', 'tireSize',
        'tireTerrain', 'tireType', 'tireWidth', 'vehicleType', 'wheelDiameter'
    ];

    /** True for undefined/null/empty-string/empty-array; false for 0, false, and non-empty objects. */
    function isBlank(value) {
        if (value === undefined || value === null) return true;
        if (typeof value === 'string') return value.trim() === '';
        if (Array.isArray(value)) return value.length === 0;
        if (typeof value === 'object') return Object.keys(value).length === 0;
        return false;
    }

    /**
     * Logs (but does not throw on) any required or currently-triggered
     * conditionally-required field that resolved to blank on this item, so
     * gaps are visible in the NetSuite execution log at map() time instead
     * of only surfacing later via Walmart's async feed response.
     * @param {string} sku
     * @param {Object} orderable - the Orderable object built in buildWalmartItem()
     * @param {Object} tiresVisible - the Visible.Tires object built in buildWalmartItem()
     * @param {string[]} triggeredConditionalFields - conditionally-required
     *   field names whose trigger condition evaluated true for this item
     */
    function logMissingRequiredFields(sku, orderable, tiresVisible, triggeredConditionalFields) {
        const missing = [];

        ALWAYS_REQUIRED_ORDERABLE_FIELDS.forEach((field) => {
            if (field === 'productIdentifiers') {
                if (isBlank(orderable.productIdentifiers.productId) || isBlank(orderable.productIdentifiers.productIdType)) {
                    missing.push('Orderable.productIdentifiers');
                }
                return;
            }
            if (isBlank(orderable[field])) missing.push(`Orderable.${field}`);
        });

        ALWAYS_REQUIRED_VISIBLE_FIELDS.forEach((field) => {
            if (isBlank(tiresVisible[field])) missing.push(`Visible.Tires.${field}`);
        });

        triggeredConditionalFields.forEach((field) => {
            if (isBlank(tiresVisible[field])) missing.push(`Visible.Tires.${field} (conditionally required)`);
        });

        if (missing.length) {
            log.error({
                title: `Tire item missing required fields (sku=${sku})`,
                details: missing.join(', ')
            });
        }
    }

    // Fields whose NetSuite custom field definition allows multiple
    // selections. A search result's `values` (or JSON.parse(context.value).values
    // in map() -- the M/R framework's own serialization of the same result,
    // same shape) returns an array of {value, text} for EVERY list/record
    // column, single- or multi-select alike (a single-select field just
    // always has exactly one entry) -- so there's no way to tell
    // "multi-select" from the shape of the data alone. This is the one place
    // that fact is declared; getColumnValue() below reads it so every call
    // site automatically gets every selected tag (array) or a single value
    // (string) without having to remember which per field. 
    const MULTISELECT_COLUMNS = new Set([
        COLUMNS.VISIBLE.TIRE_TERRAIN,
        COLUMNS.VISIBLE.TIRE_TYPE,
        COLUMNS.VISIBLE.VEHICLE_TYPE
    ]);

    /**
     * Reads a value out of a search-result `values` object, handling both
     * plain values and the {value, text} shape NetSuite returns for
     * list/record joins. Returns every selected value (array) for
     * MULTISELECT_COLUMNS fields, or just the first (string) for everything else.
     */
    function getColumnValue(values, key) {
        const raw = values[key];
        const isMulti = MULTISELECT_COLUMNS.has(key);
        if (raw === null || raw === undefined) return isMulti ? [] : '';
        if (Array.isArray(raw)) {
            const texts = raw.map((item) => (item && typeof item === 'object' ? (item.text || item.value || '') : item)).filter(Boolean);
            return isMulti ? texts : (texts[0] || '');
        }
        if (typeof raw === 'object') {
            const single = raw.text || raw.value || '';
            return isMulti ? (single ? [single] : []) : single;
        }
        return isMulti ? String(raw).split('|').map((s) => s.trim()).filter(Boolean) : raw;
    }

    /**
     * Maps a NetSuite checkbox field's value (raw boolean true/false, or the
     * "T"/"F" strings a saved search more commonly returns for checkbox
     * columns) to Walmart's "Yes"/"No" string enum -- e.g. isRunFlat.
     * Anything else (blank, or an already-correct "Yes"/"No") passes through
     * unchanged, so isBlank() can still detect a genuinely missing value.
     * @param {*} value
     * @returns {*}
     */
    function mapCheckboxToYesNo(value) {
        if (value === true || value === 'T' || value === 'true') return 'Yes';
        if (value === false || value === 'F' || value === 'false') return 'No';
        return value;
    }

    // Format depends on custitem_tire_dim_unit_type -- see
    // COLUMNS.VISIBLE.DIMENSION_UNIT_TYPE. 
    // LT-Metric doesn't use aspect ratio (uses tireHeightMeasure instead);
    // P-Metric/the no-unit-type fallback don't use tireHeightMeasure -- so
    // each branch only requires the fields its own format actually needs.
    // Adds an "LT" load-range prefix/suffix when tireClass is 'LT' (e.g.
    // "LT265/70R17").
    /**
     * Builds a tire size string (e.g. "225/60R18" or "31X10.50R15LT") from
     * its component parts, for tires whose TIRE_SIZE column is blank.
     * @param {number} tireWidthMeasure
     * @param {number} tireHeightMeasure
     * @param {string} tireAspectRatio
     * @param {number} wheelDiameterMeasure
     * @param {string} tireDimensionUnitType
     * @param {string} tireClass
     * @returns {string}
     */
    function buildTireSizeString(tireWidthMeasure, tireHeightMeasure, tireAspectRatio, wheelDiameterMeasure, tireDimensionUnitType, tireClass) {
        if (!wheelDiameterMeasure) return '';
        if (tireDimensionUnitType === 'LT-Metric (IN)') {
            if (!tireWidthMeasure || !tireHeightMeasure) return '';
            return tireClass === 'LT'
                ? `${tireHeightMeasure}X${tireWidthMeasure}R${wheelDiameterMeasure}${tireClass}`
                : `${tireHeightMeasure}X${tireWidthMeasure}R${wheelDiameterMeasure}`;
        }
        if (tireDimensionUnitType === 'P-Metrics (MM)') {
            if (!tireWidthMeasure || !tireAspectRatio) return '';
            return tireClass === 'LT'
                ? `${tireClass}${tireWidthMeasure}/${tireAspectRatio}R${wheelDiameterMeasure}`
                : `${tireWidthMeasure}/${tireAspectRatio}R${wheelDiameterMeasure}`;
        }
        if (!tireWidthMeasure || !tireAspectRatio) return '';
        return `${tireWidthMeasure}/${tireAspectRatio}R${wheelDiameterMeasure}`;
    }

    /**
     * @param {Object} values - the `values` object from a search.Result
     *   (or JSON.parse(context.value).values in map())
     * @param {string} prop65WarningText - value of the
     *   custscript_wal_prop65_warning_text script parameter // TODO: set prop 65 warning text in script params.
     * @returns {Object} one entry for the MP_ITEM feed's "MPItem" array
     */
    function buildWalmartItem(values, prop65WarningText) {
        const sku = getColumnValue(values, COLUMNS.ORDERABLE.SKU);
        const upc = getColumnValue(values, COLUMNS.ORDERABLE.PRODUCT_ID_UPC);
        const gtin = getColumnValue(values, COLUMNS.ORDERABLE.PRODUCT_ID_GTIN);
        const price = parseFloat(getColumnValue(values, COLUMNS.ORDERABLE.PRICE)) || 0;
        const shippingWeight = parseFloat(getColumnValue(values, COLUMNS.ORDERABLE.SHIPPING_WEIGHT)) || 0;
        // countryofmanufacture holds a 2-letter ISO code (e.g. "US"), not a
        // valid enum entry on its own -- translated via mapCountryOfOrigin()/
        // COUNTRY_CODE_TO_NAME above into Walmart's exact enum spelling.
        // Stays undefined (not a guessed fallback) when blank/unmapped, so
        // logMissingRequiredFields() still catches the gap.
        const countryOfOrigin = mapCountryOfOrigin(getColumnValue(values, COLUMNS.ORDERABLE.COUNTRY_OF_ORIGIN));

        const brand = getColumnValue(values, COLUMNS.VISIBLE.BRAND);
        const manufacturer = getColumnValue(values, COLUMNS.VISIBLE.MANUFACTURER) || brand;
        const assembledWeight = parseFloat(getColumnValue(values, COLUMNS.VISIBLE.ASSEMBLED_PRODUCT_WEIGHT)) || 0;
        const productName = getColumnValue(values, COLUMNS.VISIBLE.PRODUCT_NAME);
        // Model name, used as buildShortDescription()'s subject -- see COLUMNS.VISIBLE.GROUP.
        const group = getColumnValue(values, COLUMNS.VISIBLE.GROUP);

        const tireWidthMeasure = parseFloat(getColumnValue(values, COLUMNS.VISIBLE.TIRE_WIDTH)) || 0;
        const wheelDiameterMeasure = parseFloat(getColumnValue(values, COLUMNS.VISIBLE.WHEEL_DIAMETER)) || 0;
        const tireAspectRatio = getColumnValue(values, COLUMNS.VISIBLE.ASPECT_RATIO);
        const tireHeightMeasure = parseFloat(getColumnValue(values, COLUMNS.VISIBLE.TIRE_HEIGHT)) || 0;
        const tireDimensionUnitType = getColumnValue(values, COLUMNS.VISIBLE.DIMENSION_UNIT_TYPE);
        const tireClass = getColumnValue(values, COLUMNS.VISIBLE.TIRE_CLASS);
        const tireSize = getColumnValue(values, COLUMNS.VISIBLE.TIRE_SIZE)
            || buildTireSizeString(tireWidthMeasure, tireHeightMeasure, tireAspectRatio, wheelDiameterMeasure, tireDimensionUnitType, tireClass);

        const tireLoadIndex = getColumnValue(values, COLUMNS.VISIBLE.TIRE_LOAD_INDEX);
        const tireSpeedRating = getColumnValue(values, COLUMNS.VISIBLE.TIRE_SPEED_RATING);
        const tireSeason = getColumnValue(values, COLUMNS.VISIBLE.TIRE_SEASON);
        const isRunFlat = mapCheckboxToYesNo(getColumnValue(values, COLUMNS.VISIBLE.IS_RUN_FLAT));
        const electric_vehicle_tire = mapCheckboxToYesNo(getColumnValue(values, COLUMNS.VISIBLE.ELECTRIC_VEHICLE_TIRE));

        // Hardcoded -- no NetSuite field for it, and virtually every tire in the
        // catalog is radial construction anyway (bias-ply is legacy/unused here).
        const constructionType = 'Radial';
        const uniformTireQualityGrade = getColumnValue(values, COLUMNS.VISIBLE.UNIFORM_TIRE_QUALITY_GRADE);
        const tireTreadwearRating = extractTreadwearNumber(getColumnValue(values, COLUMNS.VISIBLE.TIRE_TREADWEAR_RATING));
        const mileageWarrantyMeasure = parseInt(getColumnValue(values, COLUMNS.VISIBLE.MILEAGE_WARRANTY), 10) || 0;
        const warrantyUrl = getColumnValue(values, COLUMNS.VISIBLE.WARRANTY_URL);

        const secondaryImages = [
            getColumnValue(values, COLUMNS.VISIBLE.SECONDARY_IMAGE_FACE),
            getColumnValue(values, COLUMNS.VISIBLE.SECONDARY_IMAGE_SIDE)
        ].filter(Boolean);
        const rawTireTerrain = getColumnValue(values, COLUMNS.VISIBLE.TIRE_TERRAIN);
        const rawTireType = getColumnValue(values, COLUMNS.VISIBLE.TIRE_TYPE);
        const rawVehicleType = getColumnValue(values, COLUMNS.VISIBLE.VEHICLE_TYPE);

        // --- Translate raw NetSuite picklist values to Walmart's enums ---
        // (see TIRE_TYPE_FIELD_MAPPING / VEHICLE_TYPE_MAPPING / TIRE_TERRAIN_MAPPING
        // above). Some raw tireType values are actually tireTerrain values,
        // so they get merged into the tireTerrain column's own (also mapped)
        // values here -- rawTireTerrain is no longer passed through as-is,
        // since raw NetSuite text ("Street") doesn't reliably already match
        // Walmart's tireTerrain enum spelling.
        const { tireType: tireTypeFromMapping, tireTerrain: tireTerrainFromTireType } = mapTireType(rawTireType);
        const tireTypeFromClass = TIRE_CLASS_TO_TIRE_TYPE[tireClass];
        const tireType = Array.from(new Set(tireTypeFromClass ? [...tireTypeFromMapping, tireTypeFromClass] : tireTypeFromMapping));
        const tireTerrain = Array.from(new Set([...mapTireTerrain(rawTireTerrain), ...tireTerrainFromTireType]));
        const vehicleType = mapVehicleType(rawVehicleType);

        // --- keyFeatures: always synthesized from fields the item already
        // has (see buildKeyFeatures() above) -- no NetSuite field supplies
        // this directly. May still end up short of the schema's minItems: 5
        // depending on which fields are populated -- caught by
        // logMissingRequiredFields() either way.
        const keyFeatures = buildKeyFeatures({ tireType, tireTerrain, tireSpeedRating, tireLoadIndex, tireSeason, isRunFlat });

        // --- shortDescription: synthesized from the same translated values
        // above (see buildShortDescription()), not sourced from NetSuite --
        // replaces the old raw salesdescription passthrough, which had no
        // way to reliably clear the schema's minimumWordCount=60.
        const shortDescription = buildShortDescription({
            sku, group, productName, brand, tireSize, tireType, tireTerrain, vehicleType,
            tireSpeedRating, tireLoadIndex, tireSeason, isRunFlat, uniformTireQualityGrade,
            mileageWarrantyMeasure
        });

        // --- Conditional-requirement triggers ---
        const requiresLoadSpeedConstruction = tireType.some(
            (t) => TIRE_TYPES_REQUIRING_LOAD_SPEED_CONSTRUCTION.includes(t)
        );
        const requiresUniformTireQualityGrade = tireType.some(
            (t) => TIRE_TYPES_REQUIRING_UNIFORM_QUALITY_GRADE.includes(t)
        );
        const requiresTireTreadwearRating = vehicleType.some(
            (t) => VEHICLE_TYPES_REQUIRING_TREADWEAR_RATING.includes(t)
        );
        const requiresMileageWarranty = vehicleType.some(
            (t) => VEHICLE_TYPES_REQUIRING_MILEAGE_WARRANTY.includes(t)
        );
        const triggeredConditionalFields = [
            requiresLoadSpeedConstruction && 'constructionType',
            requiresLoadSpeedConstruction && 'tireAspectRatio',
            requiresLoadSpeedConstruction && 'tireLoadIndex',
            requiresLoadSpeedConstruction && 'tireSpeedRating',
            requiresUniformTireQualityGrade && 'uniformTireQualityGrade',
            requiresTireTreadwearRating && 'tireTreadwearRating',
            requiresMileageWarranty && 'mileageWarranty',
            // has_written_warranty and isProp65WarningRequired are hardcoded, 
            // so these two always trigger
            'warrantyURL',
            'prop65WarningText'
        ].filter(Boolean);

        const tiresVisible = {
            // --- Always required ---
            productName,
            brand,
            condition: 'New',
            shortDescription, // synthesized -- see buildShortDescription() above
            keyFeatures, // synthesized, needs >= 5; can end up [] if too few contributing fields are populated -- see logMissingRequiredFields()
            mainImageUrl: getColumnValue(values, COLUMNS.VISIBLE.MAIN_IMAGE_URL),
            productSecondaryImageURL: secondaryImages, // needs >= 2; [] rather than omitted when unsourced/empty
            count: 1,
            multipackQuantity: 1,
            assembledProductWeight: assembledWeight ? { unit: 'lb', measure: assembledWeight } : undefined,
            manufacturer,
            manufacturerPartNumber: getColumnValue(values, COLUMNS.VISIBLE.MANUFACTURER_PART_NUMBER),
            netContent: { productNetContentUnit: 'Each', productNetContentMeasure: 1 },
            tireSize,
            tireWidth: tireWidthMeasure ? { unit: 'mm', measure: tireWidthMeasure } : undefined,
            wheelDiameter: wheelDiameterMeasure ? { unit: 'in', measure: wheelDiameterMeasure } : undefined,

            // --- Conditionally required (tireType-driven) -- sourced from
            // COLUMNS.VISIBLE.ASPECT_RATIO. Falls back to '' (rather than
            // undefined) when tireType requires it but the column is blank,
            // so the gap is visible in the built item instead of silently missing.
            tireAspectRatio: tireAspectRatio || (requiresLoadSpeedConstruction ? '' : undefined),

            // --- Confirmed custom fields ---
            tireLoadIndex,
            tireSpeedRating,

            // constructionType is always 'Radial' (see above), never blank, so it
            // needs no conditional fallback despite being conditionally required.
            constructionType,

            // --- Conditionally required. Falls back to ''
            // (or {} for mileageWarranty) rather than undefined whenever the
            // trigger condition is met but the column is blank, so the gap
            // stays visible in the built item instead of silently missing.
            uniformTireQualityGrade: uniformTireQualityGrade || (requiresUniformTireQualityGrade ? '' : undefined),
            tireTreadwearRating: tireTreadwearRating || (requiresTireTreadwearRating ? '' : undefined),
            mileageWarranty: mileageWarrantyMeasure
                ? { unit: 'miles', measure: mileageWarrantyMeasure }
                : (requiresMileageWarranty ? {} : undefined),

            // --- Sourced and translated via TIRE_TYPE_FIELD_MAPPING /
            // VEHICLE_TYPE_MAPPING above -- raw values with no mapping entry
            // are dropped, so these can still end up [] for an item whose
            // raw values are all unmapped (caught by logMissingRequiredFields()).
            tireTerrain,
            tireType,
            vehicleType,

            // --- Always-required. tireSeason has no NetSuite field chosen yet, so
            // it stays '' (visible in the built item and caught by
            // logMissingRequiredFields()) rather than undefined, as long as its
            // COLUMNS entry is blank. isRunFlat/electric_vehicle_tire both have
            // real checkbox fields now (see mapCheckboxToYesNo() above).
            tireSeason,
            isRunFlat,
            electric_vehicle_tire,

            // --- Hardcoded: none of our tires are flotation tires ---
            flotation_tire: 'No',

            // --- Hardcoded: every tire carries the Prop 65 warning ---
            isProp65WarningRequired: 'Yes',
            prop65WarningText: prop65WarningText || undefined,

            // --- Hardcoded: warranty is always provided via URL ---
            has_written_warranty: 'Yes - Warranty URL',
            warrantyURL: warrantyUrl || undefined
        };

        const orderable = {
            sku,
            productIdentifiers: {
                // UPC and GTIN are separate columns now, so the type is
                // known rather than guessed: prefer UPC, fall back to GTIN.
                productIdType: upc ? 'UPC' : 'GTIN',
                productId: upc || gtin
            },
            ShippingWeight: shippingWeight || undefined, // number, lbs -- not an object
            price, // number -- not an object
            country_of_origin_substantial_transformation: countryOfOrigin
        };

        logMissingRequiredFields(sku, orderable, tiresVisible, triggeredConditionalFields);

        return {
            Orderable: orderable,
            Visible: {
                Tires: tiresVisible
            }
        };
    }

    /**
     * Wraps a batch of mapped items in the MP_ITEM feed envelope.
     * @param {Object[]} items - output of buildWalmartItem(), one per item
     * @returns {string} JSON string ready to submit via submitItemFeed()
     */
    function buildFeedPayload(items) {
        return JSON.stringify({
            MPItemFeedHeader: {
                businessUnit: 'WALMART_US',
                locale: 'en',
                version: FEED_SPEC_VERSION
            },
            MPItem: items
        });
    }

    // ---------------------------------------------------------------------
    // Walmart Marketplace Item Feed API client
    // Docs: https://developer.walmart.com/us-marketplace/reference/tokenapi
    //       https://developer.walmart.com/doc/us/mp/us-mp-items/feed
    // ---------------------------------------------------------------------

    /**
     * Requests a short-lived (15 min) OAuth access token via client_credentials.
     * A fresh token is requested per call -- tokens are cheap and this avoids
     * cross-instance cache races between parallel reduce() invocations.
     *
     * @param {Object} params
     * @param {string} params.clientId
     * @param {string} params.clientSecret
     * @param {string} params.baseUrl
     * @param {string} params.correlationId
     * @returns {string} access token
     */
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
     * Builds a multipart/form-data body by hand. 
     */
    function buildMultipartBody(boundary, fileContent, filename) {
        const CRLF = '\r\n';
        return `--${boundary}${CRLF}`
            + `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}`
            + `Content-Type: application/json${CRLF}${CRLF}`
            + `${fileContent}${CRLF}`
            + `--${boundary}--${CRLF}`;
    }

    /**
     * Submits an MP_ITEM feed as a multipart/form-data "file" part.
     *
     * @param {Object} params
     * @param {string} params.accessToken
     * @param {string} params.baseUrl
     * @param {string} params.feedJson - stringified MPItemFeedHeader + MPItem payload
     * @param {string} params.correlationId
     * @param {string} params.environment - "PRODUCTION" or "SANDBOX";
     * @returns {string} feedId
     */
    function submitItemFeed(params) {
        const { accessToken, baseUrl, feedJson, correlationId, environment } = params;

        const boundary = `----WalmartFeedBoundary${random.generateUUID().replace(/-/g, '')}`;
        const multipartBody = buildMultipartBody(boundary, feedJson, 'feed.json');

        const response = https.post({
            url: `${baseUrl}/v3/feeds?feedType=${FEED_TYPE}`,
            body: multipartBody,
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'WM_SEC.ACCESS_TOKEN': accessToken,
                'WM_QOS.CORRELATION_ID': correlationId,
                'WM_SVC.NAME': 'Walmart Marketplace',
                'Accept': 'application/json',
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
            }
        });

        if (response.code !== 200) {
            // responseCode is attached (not just embedded in the message) so
            // reduce()'s catch block can distinguish a 429 rate-limit from
            // any other failure without parsing this string.
            const error = new Error(`Walmart feed submission failed (${response.code}): ${response.body}`);
            error.responseCode = response.code;
            throw error;
        }

        const parsed = JSON.parse(response.body);
        log.audit({ title: 'Walmart feed submitted', details: parsed.feedId });
        return parsed.feedId;
    }

    /**
     * Persists one row per submitted feed to FEED_RECORD.TYPE, so wm_sl_feed_status.js
     * can find pending feeds and poll their status. Logged but
     * not thrown on failure: a tracking-record failure shouldn't fail the
     * feed submission itself, since the feed has already been accepted by
     * Walmart at this point.
     * @param {Object} params
     * @param {string} params.feedId
     * @param {string} params.bucket - the M/R reduce() context.key
     * @param {number} params.itemCount
     * @param {string} params.environment - "PRODUCTION" or "SANDBOX"
     * @param {string} params.correlationId - the submission call's WM_QOS.CORRELATION_ID,
     *   so it's still recoverable after the execution log rolls off
     * @param {string} params.feedType - e.g. "MP_ITEM" (see FEED_TYPE)
     * @param {string} params.itemType - Walmart product category, e.g. "Tires" (see WALMART_ITEM_TYPE)
     * @param {string} params.skus - every SKU in this feed, joined with "|"
     */
    function recordFeedSubmission(params) {
        const { feedId, bucket, itemCount, environment, correlationId, feedType, itemType, skus } = params;
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
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.FEED_TYPE, value: feedType });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.ITEM_TYPE, value: itemType });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.SKUS, value: skus });
            rec.save();
        } catch (e) {
            log.error({ title: `Failed to record feed submission tracking (feedId=${feedId})`, details: e });
        }
    }

    /**
     * Persists one row for a bucket that FAILED to submit at all (no feedId
     * was ever issued by Walmart) -- e.g. a 429 rate-limit or any other
     * non-200 response.
     * @param {string} params.feedType - e.g. "MP_ITEM" (see FEED_TYPE)
     * @param {string} params.itemType - Walmart product category, e.g. "Tires" (see WALMART_ITEM_TYPE)
     * @param {string} params.skus - every SKU in this bucket, joined with "|"
     * @param {string} params.status - FEED_STATUS.ERROR or FEED_STATUS.RATE_LIMITED
     * @param {string} params.errorMessage
     */
    function recordFailedFeedSubmission(params) {
        const { bucket, itemCount, environment, correlationId, feedType, itemType, skus, status, errorMessage } = params;
        try {
            const rec = record.create({ type: FEED_RECORD.TYPE, isDynamic: false });
            rec.setValue({ fieldId: 'name', value: `${status}-bucket${bucket}-${correlationId}` });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.STATUS, value: status });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.ENVIRONMENT, value: environment });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.ITEM_COUNT, value: itemCount });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.SUBMITTED_DATE, value: new Date() });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.BUCKET, value: bucket });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.CORRELATION_ID, value: correlationId });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.FEED_TYPE, value: feedType });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.ITEM_TYPE, value: itemType });
            rec.setValue({ fieldId: FEED_RECORD.FIELDS.SKUS, value: skus });
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
            savedSearchId: script.getParameter({ name: 'custscript_wal_tireupload_saved_search' }), 
            clientId: script.getParameter({ name: 'custscript_wal_tireupload_client_id' }),
            clientSecret: script.getParameter({ name: 'custscript_wal_tireupload_client_secret' }),
            environment: script.getParameter({ name: 'custscript_wal_tireupload_env' }) || 'SANDBOX',
            bucketSize: parseInt(script.getParameter({ name: 'custscript_wal_tireupload_bucket_size' }), 10) || 1000,
            prop65WarningText: script.getParameter({ name: PROP65_WARNING_TEXT_PARAM })
        };
    }

    function getBaseUrl(environment) {
        return environment === 'PRODUCTION' ? BASE_URLS.PRODUCTION : BASE_URLS.SANDBOX;
    }

    const getInputData = () => {
        const { savedSearchId, bucketSize } = getScriptParams();
        if (!savedSearchId) {
            throw new Error('Missing required script parameter: custscript_wal_tireupload_saved_search');
        }

        // Populates the bucket-count cache up front via a cheap count-only
        // query (see getNumBuckets()) so it's ready before map() needs it --
        // this does NOT load the actual rows here; that still happens below
        // via the framework's own pagination.
        getNumBuckets(savedSearchId, bucketSize);

        // Returning the search object directly lets the Map/Reduce framework
        // handle pagination/governance for the real row-by-row read.
        return search.load({ id: savedSearchId });
    };

    const map = (context) => {
        const { savedSearchId, bucketSize, prop65WarningText } = getScriptParams();
        const numBuckets = getNumBuckets(savedSearchId, bucketSize);
        const result = JSON.parse(context.value);
        const values = result.values;

        const walmartItem = buildWalmartItem(values, prop65WarningText);
        const internalId = parseInt(result.id, 10);
        const bucket = internalId % numBuckets;

        context.write({
            key: String(bucket),
            value: JSON.stringify(walmartItem)
        });
    };

    const reduce = (context) => {
        const { clientId, clientSecret, environment } = getScriptParams();
        if (!clientId || !clientSecret) {
            throw new Error('Missing Walmart API credentials script parameters.');
        }

        const baseUrl = getBaseUrl(environment);

        const items = context.values.map((v) => JSON.parse(v));
        const feedJson = buildFeedPayload(items);
        const skus = items.map((item) => item.Orderable.sku).join('|');

        // Each Walmart call gets its own correlation ID -- separate requests,
        // separate WM_QOS.CORRELATION_ID. Reassigning the same variable
        // (rather than two separately-named ones) means the tracking record
        // gets the feed submission's own ID (what Walmart support would
        // actually need), while an uncaught error from either call still
        // carries its own correct ID in its message.
        let correlationId = random.generateUUID();
        const accessToken = getAccessToken({ clientId, clientSecret, baseUrl, correlationId });

        correlationId = random.generateUUID();

        let feedId;
        try {
            feedId = submitItemFeed({ accessToken, baseUrl, feedJson, correlationId, environment });
        } catch (e) {
            const status = e.responseCode === 429 ? FEED_STATUS.RATE_LIMITED : FEED_STATUS.ERROR;
            recordFailedFeedSubmission({
                bucket: context.key,
                itemCount: items.length,
                environment,
                correlationId,
                feedType: FEED_TYPE,
                itemType: WALMART_ITEM_TYPE,
                skus,
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
            feedType: FEED_TYPE,
            itemType: WALMART_ITEM_TYPE,
            skus
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
            title: 'Walmart tire upload summary',
            details: `feeds submitted=${feedIds.length}, mapErrors=${mapErrors}, reduceErrors=${reduceErrors}, feedIds=${feedIds.join(', ')}`
        });
    };

    return { getInputData, map, reduce, summarize };
});
