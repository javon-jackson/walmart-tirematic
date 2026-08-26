/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * Ops tool for creating a Walmart "Shipping Template" (a named set of shipping
 * methods/rates/transit-time rules, assigned to items in Seller Center) through
 * Walmart's Create Shipping Templates API -- POST /v3/settings/shipping/templates.
 *
 *   STEP 1 (SETUP): user enters the template-level fields (name, type, rate model,
 *     status, optional international shipping type/fulfillment centers) and checks
 *     which shipping methods (VALUE/STANDARD/FREIGHT) the template includes, with each
 *     checked method's own status (ACTIVE/INACTIVE) set right alongside it -- status is
 *     a method-level property in Walmart's schema, so it's asked once per method here,
 *     not per configuration later. STANDARD is required. These, plus the chosen
 *     rateModelType (it decides which pricing fields the methods step shows), ride
 *     forward as hidden fields. Regardless of what's checked here, buildTemplatePayload()
 *     always appends a free VALUE fallback covering the whole 48-state region and AK/HI --
 *     see that function's own comment for why.
 *   STEP 2 (CHOOSE REGIONS): Walmart lets one shipping method carry several independent
 *     configurations (different regions/pricing each, e.g. one rate for most of the
 *     country and a separate one for a narrowed region) -- so for EACH method checked in
 *     STEP 1, this renders up to MAX_CONFIGS_PER_METHOD configuration slots, each with its
 *     own top-level region picker (48 State / AK+HI / US Protectorates / APO-FPO). Only
 *     the first slot per method defaults to a region checked; the rest start blank and
 *     are simply skipped later if left that way -- most templates only need the first
 *     slot per method. A slot checking "C" (48 State) is what gates that slot's own
 *     section in STEP 2B below.
 *   STEP 2B (SCOPE STATES, one section per slot that checked "C" in STEP 2): optional,
 *     per slot -- lets the seller narrow that specific configuration down to specific
 *     states/stateSubregions (grouped by subRegion, using REGION_MAPPING_TABLE -- see
 *     below) instead of the whole 48-State region. Entirely skipped if no slot checked
 *     "C" in STEP 2; otherwise renders one full state/stateSubregion picker per slot
 *     that did.
 *   STEP 3 (METHODS): renders one block per active configuration slot -- address types,
 *     transit time (the slot's own regions and any state narrowing were already decided
 *     in STEP 2/2B and are just displayed/carried forward here, not re-picked), and
 *     EITHER flat per-shipment pricing fields OR up to MAX_TIERS tiered-pricing rows,
 *     depending on the rateModelType picked in STEP 1. Any tier row left completely
 *     blank is dropped rather than sent to Walmart as a bogus 0/0/$0 tier. Submitting
 *     groups every slot back together by method (see buildTemplatePayload()) into the
 *     full nested payload and POSTs it.
 *
 * Script parameters:
 *   custscript_wal_ship_template_client_id  - Walmart Marketplace API Client ID
 *   custscript_wal_ship_template_secret     - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_ship_template_env        - "PRODUCTION" or "SANDBOX"
 */
define(
    ['N/record', 'N/runtime', 'N/https', 'N/encode', 'N/log', 'N/crypto/random', 'N/ui/serverWidget', 'N/ui/message', 'N/url'],
    (record, runtime, https, encode, log, random, serverWidget, message, url) => {

        const BASE_URLS = {
            PRODUCTION: 'https://marketplace.walmartapis.com',
            SANDBOX: 'https://sandbox.walmartapis.com'
        };

        const BUTTON_STYLE = 'display:inline-block;padding:10px 20px;background:#187bf2;color:#fff;'
            + 'font-weight:bold;font-size:14px;text-decoration:none;border-radius:3px;border:none;cursor:pointer;';

        const PARAMS = {
            CLIENT_ID: 'custscript_wal_ship_template_client_id',
            CLIENT_SECRET: 'custscript_wal_ship_template_secret',
            ENVIRONMENT: 'custscript_wal_ship_template_env'
        };

        // TIERED_PRICING charges by the ITEM'S PRICE -- minLimit/maxLimit below are item/order
        // price-range boundaries, shipCharge is the flat charge for that price band.
        //
        // PER_SHIPMENT_PRICING charges by WEIGHT (chargePerWeight, per pound) and/or ITEM COUNT
        // (chargePerItem).
        const RATE_MODEL_TYPES = {
            TIERED_PRICING: 'Tiered Pricing (by item price)',
            PER_SHIPMENT_PRICING: 'Per-Shipment Pricing (by weight and/or item count)'
        };
        const TEMPLATE_STATUSES = { ACTIVE: 'Active', INACTIVE: 'Inactive' };
        // THREE_DAY/TWO_DAY/ONE_DAY commented out -- these are expedited/performance-gated
        // programs, not freely selectable like VALUE/STANDARD/FREIGHT. Walmart only unlocks
        // them once a seller meets its performance criteria (on-time shipping/delivery rates,
        // etc.) -- see the expedited delivery programs guide:
        // https://marketplacelearn.walmart.com/guides/Shipping%20&%20fulfillment/Shipping%20methods/Shipping-methods:-expedited-delivery-programs
        // Re-enable the 3 commented lines below once that criteria is confirmed met/approved
        // for this seller account.
        const SHIP_METHODS = {
            VALUE: 'Value (6-7 day transit)', STANDARD: 'Standard (3-5 day transit)',
            // THREE_DAY: 'Three Day',
            // TWO_DAY: 'Two Day',
            // ONE_DAY: 'One Day',
            FREIGHT: 'Freight (6-10 day transit)'
        };

        // https://marketplacelearn.walmart.com/guides/Shipping%20&%20fulfillment/Shipping%20methods/Shipping-methods:-Overview
        const SHIP_METHOD_TRANSIT_TIME_DAYS = {
            VALUE: { min: 6, max: 7 },
            STANDARD: { min: 3, max: 5 },
            THREE_DAY: { min: 3, max: 3 },
            TWO_DAY: { min: 2, max: 2 },
            ONE_DAY: { min: 1, max: 1 },
            FREIGHT: { min: 6, max: 10 }
        };
        
        // A shipping fee cannot be charged for these ship method. See docs for more info.
        // https://marketplacelearn.walmart.com/guides/Shipping%20&%20fulfillment/Shipping%20methods/Shipping-methods:-Overview
        const FREE_ONLY_SHIP_METHODS = ['VALUE', 'TWO_DAY'];

        const ADDRESS_TYPES = { STREET: 'Street', PO_BOX: 'PO Box', MILITARY: 'Military (APO/FPO)' };
        const SHIPPING_TYPES = { '': '-- Domestic (default) --', INTERNATIONAL: 'International' };

        // These were the only region codes listed in Walmart's docs and examples.
        // https://developer.walmart.com/us-marketplace/docs/create-shipping-templates
        const REGION_CODES = { C: '48 State', H: 'AK and HI', P: 'US Protectorates', A: 'APO/FPO' };

        // UI-only friendly labels for the 4 subRegions under region C.
        const SUBREGION_DISPLAY_NAMES = { NE: 'Northeast', MW: 'Midwest', SO: 'South', WE: 'West' };

        const STATE_NAMES = {
            AL: 'Alabama', AR: 'Arkansas', AZ: 'Arizona', CA: 'California', CO: 'Colorado',
            CT: 'Connecticut', DC: 'District of Columbia', DE: 'Delaware', FL: 'Florida',
            GA: 'Georgia', IA: 'Iowa', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', KS: 'Kansas',
            KY: 'Kentucky', LA: 'Louisiana', MA: 'Massachusetts', MD: 'Maryland', ME: 'Maine',
            MI: 'Michigan', MN: 'Minnesota', MO: 'Missouri', MS: 'Mississippi', MT: 'Montana',
            NC: 'North Carolina', ND: 'North Dakota', NE: 'Nebraska', NH: 'New Hampshire',
            NJ: 'New Jersey', NM: 'New Mexico', NV: 'Nevada', NY: 'New York', OH: 'Ohio',
            OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
            SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
            VA: 'Virginia', VT: 'Vermont', WA: 'Washington', WI: 'Wisconsin', WV: 'West Virginia',
            WY: 'Wyoming'
        };

        /**
         * Confirmed against Walmart's own Region Mapping Reference Table.
         */
        const REGION_MAPPING_TABLE = [
            { subRegion: 'SO', state: 'AL', stateSubregionName: 'AL_NORTH', stateSubregionCode: 'AL1' },
            { subRegion: 'SO', state: 'AL', stateSubregionName: 'AL_SOUTH', stateSubregionCode: 'AL2' },
            { subRegion: 'SO', state: 'AR', stateSubregionName: 'AR_EAST', stateSubregionCode: 'AR1' },
            { subRegion: 'SO', state: 'AR', stateSubregionName: 'AR_WEST', stateSubregionCode: 'AR2' },
            { subRegion: 'WE', state: 'AZ', stateSubregionName: 'AZ_NORTH', stateSubregionCode: 'AZ1' },
            { subRegion: 'WE', state: 'AZ', stateSubregionName: 'AZ_PHOENIX', stateSubregionCode: 'AZ2' },
            { subRegion: 'WE', state: 'AZ', stateSubregionName: 'AZ_SOUTH', stateSubregionCode: 'AZ3' },
            { subRegion: 'WE', state: 'CA', stateSubregionName: 'CA_CENTRAL', stateSubregionCode: 'CA1' },
            { subRegion: 'WE', state: 'CA', stateSubregionName: 'CA_CENTRAL_NORTH', stateSubregionCode: 'CA2' },
            { subRegion: 'WE', state: 'CA', stateSubregionName: 'CA_CENTRAL_SOUTH', stateSubregionCode: 'CA3' },
            { subRegion: 'WE', state: 'CA', stateSubregionName: 'CA_CENTRAL_WEST', stateSubregionCode: 'CA4' },
            { subRegion: 'WE', state: 'CA', stateSubregionName: 'CA_LONG_BEACH', stateSubregionCode: 'CA5' },
            { subRegion: 'WE', state: 'CA', stateSubregionName: 'CA_LOS_ANGELES', stateSubregionCode: 'CA6' },
            { subRegion: 'WE', state: 'CA', stateSubregionName: 'CA_LOS_ANGELES_VENTURA_COUNTY', stateSubregionCode: 'CA7' },
            { subRegion: 'WE', state: 'CA', stateSubregionName: 'CA_NORTH', stateSubregionCode: 'CA8' },
            { subRegion: 'WE', state: 'CA', stateSubregionName: 'CA_ONTARIO', stateSubregionCode: 'CA9' },
            { subRegion: 'WE', state: 'CA', stateSubregionName: 'CA_RIVERSIDE_IMPERIAL', stateSubregionCode: 'CA10' },
            { subRegion: 'WE', state: 'CA', stateSubregionName: 'CA_SAN_BERNARDINO', stateSubregionCode: 'CA11' },
            { subRegion: 'WE', state: 'CA', stateSubregionName: 'CA_SAN_DIEGO', stateSubregionCode: 'CA12' },
            { subRegion: 'WE', state: 'CA', stateSubregionName: 'CA_SAN_DIEGO_COUNTY', stateSubregionCode: 'CA13' },
            { subRegion: 'WE', state: 'CA', stateSubregionName: 'CA_SAN_FRANCISCO', stateSubregionCode: 'CA14' },
            { subRegion: 'WE', state: 'CA', stateSubregionName: 'CA_SANTA_ANA', stateSubregionCode: 'CA15' },
            { subRegion: 'WE', state: 'CO', stateSubregionName: 'CO_CENTRAL', stateSubregionCode: 'CO1' },
            { subRegion: 'WE', state: 'CO', stateSubregionName: 'CO_REST_ALL', stateSubregionCode: 'CO2' },
            { subRegion: 'NE', state: 'CT', stateSubregionName: 'CT_REST_ALL', stateSubregionCode: 'CT1' },
            { subRegion: 'NE', state: 'CT', stateSubregionName: 'CT_SOUTH_WEST', stateSubregionCode: 'CT2' },
            { subRegion: 'SO', state: 'DC', stateSubregionName: 'DC', stateSubregionCode: 'DC' },
            { subRegion: 'SO', state: 'DE', stateSubregionName: 'DE', stateSubregionCode: 'DE' },
            { subRegion: 'SO', state: 'FL', stateSubregionName: 'FL_CENTRAL_EAST', stateSubregionCode: 'FL1' },
            { subRegion: 'SO', state: 'FL', stateSubregionName: 'FL_CENTRAL_WEST', stateSubregionCode: 'FL2' },
            { subRegion: 'SO', state: 'FL', stateSubregionName: 'FL_MIAMI', stateSubregionCode: 'FL3' },
            { subRegion: 'SO', state: 'FL', stateSubregionName: 'FL_NORTH', stateSubregionCode: 'FL4' },
            { subRegion: 'SO', state: 'FL', stateSubregionName: 'FL_SOUTH_EAST', stateSubregionCode: 'FL5' },
            { subRegion: 'SO', state: 'FL', stateSubregionName: 'FL_SOUTH_WEST', stateSubregionCode: 'FL6' },
            { subRegion: 'SO', state: 'GA', stateSubregionName: 'GA_ATLANTA', stateSubregionCode: 'GA1' },
            { subRegion: 'SO', state: 'GA', stateSubregionName: 'GA_CENTRAL', stateSubregionCode: 'GA2' },
            { subRegion: 'SO', state: 'GA', stateSubregionName: 'GA_NORTH_EAST', stateSubregionCode: 'GA3' },
            { subRegion: 'SO', state: 'GA', stateSubregionName: 'GA_NORTH_WEST', stateSubregionCode: 'GA4' },
            { subRegion: 'SO', state: 'GA', stateSubregionName: 'GA_SOUTH', stateSubregionCode: 'GA5' },
            { subRegion: 'MW', state: 'IA', stateSubregionName: 'IA_CENTRAL', stateSubregionCode: 'IA1' },
            { subRegion: 'MW', state: 'IA', stateSubregionName: 'IA_REST', stateSubregionCode: 'IA2' },
            { subRegion: 'WE', state: 'ID', stateSubregionName: 'ID_BOISE_AND_NAMPA', stateSubregionCode: 'ID1' },
            { subRegion: 'WE', state: 'ID', stateSubregionName: 'ID_NORTH_AND_EAST', stateSubregionCode: 'ID2' },
            { subRegion: 'MW', state: 'IL', stateSubregionName: 'IL_CHICAGO', stateSubregionCode: 'IL1' },
            { subRegion: 'MW', state: 'IL', stateSubregionName: 'IL_NORTH_EAST', stateSubregionCode: 'IL2' },
            { subRegion: 'MW', state: 'IL', stateSubregionName: 'IL_NORTH_WEST', stateSubregionCode: 'IL3' },
            { subRegion: 'MW', state: 'IL', stateSubregionName: 'IL_SOUTHEAST', stateSubregionCode: 'IL4' },
            { subRegion: 'MW', state: 'IL', stateSubregionName: 'IL_SOUTHWEST', stateSubregionCode: 'IL5' },
            { subRegion: 'MW', state: 'IN', stateSubregionName: 'IN_CENTRAL_AND_EAST', stateSubregionCode: 'IN1' },
            { subRegion: 'MW', state: 'IN', stateSubregionName: 'IN_NORTH', stateSubregionCode: 'IN2' },
            { subRegion: 'MW', state: 'IN', stateSubregionName: 'IN_SOUTH', stateSubregionCode: 'IN3' },
            { subRegion: 'MW', state: 'IN', stateSubregionName: 'IN_WEST', stateSubregionCode: 'IN4' },
            { subRegion: 'MW', state: 'KS', stateSubregionName: 'KS_EAST', stateSubregionCode: 'KS1' },
            { subRegion: 'MW', state: 'KS', stateSubregionName: 'KS_WEST', stateSubregionCode: 'KS2' },
            { subRegion: 'SO', state: 'KY', stateSubregionName: 'KY_EAST', stateSubregionCode: 'KY1' },
            { subRegion: 'SO', state: 'KY', stateSubregionName: 'KY_WEST', stateSubregionCode: 'KY2' },
            { subRegion: 'SO', state: 'LA', stateSubregionName: 'LA_NORTH', stateSubregionCode: 'LA1' },
            { subRegion: 'SO', state: 'LA', stateSubregionName: 'LA_SOUTH', stateSubregionCode: 'LA2' },
            { subRegion: 'NE', state: 'MA', stateSubregionName: 'MA_EAST', stateSubregionCode: 'MA1' },
            { subRegion: 'NE', state: 'MA', stateSubregionName: 'MA_WEST', stateSubregionCode: 'MA2' },
            { subRegion: 'SO', state: 'MD', stateSubregionName: 'MD_CENTRAL', stateSubregionCode: 'MD1' },
            { subRegion: 'SO', state: 'MD', stateSubregionName: 'MD_REST_ALL', stateSubregionCode: 'MD2' },
            { subRegion: 'NE', state: 'ME', stateSubregionName: 'ME_EAST', stateSubregionCode: 'ME1' },
            { subRegion: 'NE', state: 'ME', stateSubregionName: 'ME_WEST', stateSubregionCode: 'ME2' },
            { subRegion: 'MW', state: 'MI', stateSubregionName: 'MI_CENTRAL', stateSubregionCode: 'MI1' },
            { subRegion: 'MW', state: 'MI', stateSubregionName: 'MI_NORTH', stateSubregionCode: 'MI2' },
            { subRegion: 'MW', state: 'MI', stateSubregionName: 'MI_SOUTH_EAST', stateSubregionCode: 'MI3' },
            { subRegion: 'MW', state: 'MN', stateSubregionName: 'MN_CENTRAL_EAST', stateSubregionCode: 'MN1' },
            { subRegion: 'MW', state: 'MN', stateSubregionName: 'MN_REST_ALL', stateSubregionCode: 'MN2' },
            { subRegion: 'MW', state: 'MO', stateSubregionName: 'MO_EAST', stateSubregionCode: 'MO1' },
            { subRegion: 'MW', state: 'MO', stateSubregionName: 'MO_SOUTH', stateSubregionCode: 'MO2' },
            { subRegion: 'MW', state: 'MO', stateSubregionName: 'MO_WEST', stateSubregionCode: 'MO3' },
            { subRegion: 'SO', state: 'MS', stateSubregionName: 'MS_NORTH', stateSubregionCode: 'MS1' },
            { subRegion: 'SO', state: 'MS', stateSubregionName: 'MS_SOUTH', stateSubregionCode: 'MS2' },
            { subRegion: 'WE', state: 'MT', stateSubregionName: 'MT', stateSubregionCode: 'MT' },
            { subRegion: 'SO', state: 'NC', stateSubregionName: 'NC_EAST', stateSubregionCode: 'NC1' },
            { subRegion: 'SO', state: 'NC', stateSubregionName: 'NC_NORTH', stateSubregionCode: 'NC2' },
            { subRegion: 'SO', state: 'NC', stateSubregionName: 'NC_SOUTH', stateSubregionCode: 'NC3' },
            { subRegion: 'SO', state: 'NC', stateSubregionName: 'NC_WEST', stateSubregionCode: 'NC4' },
            { subRegion: 'MW', state: 'ND', stateSubregionName: 'ND', stateSubregionCode: 'ND' },
            { subRegion: 'MW', state: 'NE', stateSubregionName: 'NE', stateSubregionCode: 'NE' },
            { subRegion: 'NE', state: 'NH', stateSubregionName: 'NH', stateSubregionCode: 'NH' },
            { subRegion: 'NE', state: 'NJ', stateSubregionName: 'NJ_CENTRAL', stateSubregionCode: 'NJ1' },
            { subRegion: 'NE', state: 'NJ', stateSubregionName: 'NJ_NORTH', stateSubregionCode: 'NJ2' },
            { subRegion: 'NE', state: 'NJ', stateSubregionName: 'NJ_SOUTH', stateSubregionCode: 'NJ3' },
            { subRegion: 'NE', state: 'NJ', stateSubregionName: 'NJ_KEARNY', stateSubregionCode: 'NJ4' },
            { subRegion: 'WE', state: 'NM', stateSubregionName: 'NM_CENTRAL', stateSubregionCode: 'NM1' },
            { subRegion: 'WE', state: 'NM', stateSubregionName: 'NM_REST_ALL', stateSubregionCode: 'NM2' },
            { subRegion: 'WE', state: 'NV', stateSubregionName: 'NV_LAS_VEGAS', stateSubregionCode: 'NV1' },
            { subRegion: 'WE', state: 'NV', stateSubregionName: 'NV_NORTH', stateSubregionCode: 'NV2' },
            { subRegion: 'WE', state: 'NV', stateSubregionName: 'NV_SOUTH', stateSubregionCode: 'NV3' },
            { subRegion: 'NE', state: 'NY', stateSubregionName: 'NY_BROOKLYN', stateSubregionCode: 'NY1' },
            { subRegion: 'NE', state: 'NY', stateSubregionName: 'NY_CENTRAL', stateSubregionCode: 'NY2' },
            { subRegion: 'NE', state: 'NY', stateSubregionName: 'NY_NORTH_CENTRAL', stateSubregionCode: 'NY3' },
            { subRegion: 'NE', state: 'NY', stateSubregionName: 'NY_NORTH_WEST', stateSubregionCode: 'NY4' },
            { subRegion: 'NE', state: 'NY', stateSubregionName: 'NY_SOUTH', stateSubregionCode: 'NY5' },
            { subRegion: 'MW', state: 'OH', stateSubregionName: 'OH_CENTRAL', stateSubregionCode: 'OH1' },
            { subRegion: 'MW', state: 'OH', stateSubregionName: 'OH_NORTH', stateSubregionCode: 'OH2' },
            { subRegion: 'MW', state: 'OH', stateSubregionName: 'OH_SOUTH_EAST', stateSubregionCode: 'OH3' },
            { subRegion: 'MW', state: 'OH', stateSubregionName: 'OH_WEST', stateSubregionCode: 'OH4' },
            { subRegion: 'SO', state: 'OK', stateSubregionName: 'OK_NORTH_EAST', stateSubregionCode: 'OK1' },
            { subRegion: 'SO', state: 'OK', stateSubregionName: 'OK_REST_ALL', stateSubregionCode: 'OK2' },
            { subRegion: 'WE', state: 'OR', stateSubregionName: 'OR_CENTRAL', stateSubregionCode: 'OR1' },
            { subRegion: 'WE', state: 'OR', stateSubregionName: 'OR_NORTH_WEST', stateSubregionCode: 'OR2' },
            { subRegion: 'NE', state: 'PA', stateSubregionName: 'PA_CENTRAL', stateSubregionCode: 'PA1' },
            { subRegion: 'NE', state: 'PA', stateSubregionName: 'PA_CENTRAL_NORTH', stateSubregionCode: 'PA2' },
            { subRegion: 'NE', state: 'PA', stateSubregionName: 'PA_NORTH_EAST', stateSubregionCode: 'PA3' },
            { subRegion: 'NE', state: 'PA', stateSubregionName: 'PA_SOUTH', stateSubregionCode: 'PA4' },
            { subRegion: 'NE', state: 'PA', stateSubregionName: 'PA_WEST', stateSubregionCode: 'PA5' },
            { subRegion: 'NE', state: 'RI', stateSubregionName: 'RI', stateSubregionCode: 'RI' },
            { subRegion: 'SO', state: 'SC', stateSubregionName: 'SC_CENTRAL', stateSubregionCode: 'SC1' },
            { subRegion: 'SO', state: 'SC', stateSubregionName: 'SC_NORTH', stateSubregionCode: 'SC2' },
            { subRegion: 'SO', state: 'SC', stateSubregionName: 'SC_SOUTH', stateSubregionCode: 'SC3' },
            { subRegion: 'MW', state: 'SD', stateSubregionName: 'SD_EAST', stateSubregionCode: 'SD1' },
            { subRegion: 'MW', state: 'SD', stateSubregionName: 'SD_WEST', stateSubregionCode: 'SD2' },
            { subRegion: 'SO', state: 'TN', stateSubregionName: 'TN_CENTRAL', stateSubregionCode: 'TN1' },
            { subRegion: 'SO', state: 'TN', stateSubregionName: 'TN_EAST', stateSubregionCode: 'TN2' },
            { subRegion: 'SO', state: 'TN', stateSubregionName: 'TN_WEST', stateSubregionCode: 'TN3' },
            { subRegion: 'SO', state: 'TX', stateSubregionName: 'TX_CENTRAL', stateSubregionCode: 'TX1' },
            { subRegion: 'SO', state: 'TX', stateSubregionName: 'TX_CENTRAL_NORTH', stateSubregionCode: 'TX2' },
            { subRegion: 'SO', state: 'TX', stateSubregionName: 'TX_CENTRAL_WEST', stateSubregionCode: 'TX3' },
            { subRegion: 'SO', state: 'TX', stateSubregionName: 'TX_DALLAS', stateSubregionCode: 'TX4' },
            { subRegion: 'SO', state: 'TX', stateSubregionName: 'TX_HOUSTON', stateSubregionCode: 'TX5' },
            { subRegion: 'SO', state: 'TX', stateSubregionName: 'TX_NORTH_EAST', stateSubregionCode: 'TX6' },
            { subRegion: 'SO', state: 'TX', stateSubregionName: 'TX_NORTH_WEST', stateSubregionCode: 'TX7' },
            { subRegion: 'SO', state: 'TX', stateSubregionName: 'TX_SOUTH', stateSubregionCode: 'TX8' },
            { subRegion: 'SO', state: 'TX', stateSubregionName: 'TX_SOUTH_EAST', stateSubregionCode: 'TX9' },
            { subRegion: 'SO', state: 'TX', stateSubregionName: 'TX_SOUTH_WEST', stateSubregionCode: 'TX10' },
            { subRegion: 'WE', state: 'UT', stateSubregionName: 'UT_NORTH', stateSubregionCode: 'UT1' },
            { subRegion: 'WE', state: 'UT', stateSubregionName: 'UT_SOUTH', stateSubregionCode: 'UT2' },
            { subRegion: 'SO', state: 'VA', stateSubregionName: 'VA_CENTRAL', stateSubregionCode: 'VA1' },
            { subRegion: 'SO', state: 'VA', stateSubregionName: 'VA_NORTH', stateSubregionCode: 'VA2' },
            { subRegion: 'SO', state: 'VA', stateSubregionName: 'VA_SOUTH_EAST', stateSubregionCode: 'VA3' },
            { subRegion: 'SO', state: 'VA', stateSubregionName: 'VA_SOUTH_WEST', stateSubregionCode: 'VA4' },
            { subRegion: 'NE', state: 'VT', stateSubregionName: 'VT', stateSubregionCode: 'VT' },
            { subRegion: 'WE', state: 'WA', stateSubregionName: 'WA', stateSubregionCode: 'WA' },
            { subRegion: 'MW', state: 'WI', stateSubregionName: 'WI_EAST', stateSubregionCode: 'WI1' },
            { subRegion: 'MW', state: 'WI', stateSubregionName: 'WI_WEST', stateSubregionCode: 'WI2' },
            { subRegion: 'SO', state: 'WV', stateSubregionName: 'WV_EAST', stateSubregionCode: 'WV1' },
            { subRegion: 'SO', state: 'WV', stateSubregionName: 'WV_WEST', stateSubregionCode: 'WV2' },
            { subRegion: 'WE', state: 'WY', stateSubregionName: 'WY', stateSubregionCode: 'WY' }
        ];

        /**
         * Derived ONCE from REGION_MAPPING_TABLE above:
         *   STATES_BY_SUBREGION: subRegion code -> [state codes], in table order.
         *   STATE_SUBREGIONS_BY_STATE: state code -> [{code, name}], in table order.
         *   STATE_TO_SUBREGION: state code -> its parent subRegion code (needed to nest a
         *     narrowed state back under the right subRegions[] entry when building the payload).
         *   ALL_C_LEAVES: every stateSubregionCode in the table -- the finest granularity this
         *     tool can express for region "C", used to detect geographic overlap between a flat
         *     48-State configuration and a narrowed one (see getRegionLeaves()).
         */
        const STATES_BY_SUBREGION = {};
        const STATE_SUBREGIONS_BY_STATE = {};
        const STATE_TO_SUBREGION = {};
        REGION_MAPPING_TABLE.forEach((row) => {
            if (!STATES_BY_SUBREGION[row.subRegion]) STATES_BY_SUBREGION[row.subRegion] = [];
            if (!STATES_BY_SUBREGION[row.subRegion].includes(row.state)) STATES_BY_SUBREGION[row.subRegion].push(row.state);
            if (!STATE_SUBREGIONS_BY_STATE[row.state]) STATE_SUBREGIONS_BY_STATE[row.state] = [];
            STATE_SUBREGIONS_BY_STATE[row.state].push({ code: row.stateSubregionCode, name: row.stateSubregionName });
            STATE_TO_SUBREGION[row.state] = row.subRegion;
        });
        const ALL_C_LEAVES = REGION_MAPPING_TABLE.map((row) => row.stateSubregionCode);

        // Every method key gets exactly one shippingMethods[] entry in the payload
        // Regions and shipping rates are set in configurations[] per ship method.
        const METHOD_KEYS = Object.keys(SHIP_METHODS);
        const MAX_CONFIGS_PER_METHOD = 6;
        const MAX_TIERS = 5;

        const RESULT_RECORD = {
            TYPE: 'customrecord_wal_shipping_templates',
            FIELDS: {
                NAME: 'custrecord_wal_shiptmpl_name',
                TEMPLATE_ID: 'custrecord_wal_shiptmpl_id',
                STATUS: 'custrecord_wal_shiptmpl_status',                   // this script's OWN Confirmed/Error outcome
                RESPONSE: 'custrecord_wal_shiptmpl_response',
                ERROR: 'custrecord_wal_shiptmpl_error',
                CORRELATION: 'custrecord_wal_shiptmpl_correlation_id',
                DATE_CREATED: 'custrecord_wal_shiptmpl_date_created',
                RATE_MODEL_TYPE: 'custrecord_wal_shiptmpl_rate_model',      // TIERED_PRICING / PER_SHIPMENT_PRICING
                TEMPLATE_TYPE: 'custrecord_wal_shiptmpl_type',              // CUSTOM / 3PL value
                TEMPLATE_STATUS: 'custrecord_wal_shiptmpl_active_status',   // Walmart's OWN ACTIVE/INACTIVE status field, distinct from STATUS above
                SHIPPING_TYPE: 'custrecord_wal_shiptmpl_shipping_type',     // always set -- 'DOMESTIC' (this script's own label, not a Walmart enum value) or Walmart's 'INTERNATIONAL'
                METHOD_SUMMARY: 'custrecord_wal_shiptmpl_methods'           // comma list of shipMethod values included
            },
            STATUS: { SUCCESS: 'Success', ERROR: 'Error' }
        };

        const ACTION = {
            CHOOSE_REGIONS: 'chooseRegions',
            SCOPE_STATES: 'scopeStates',
            CONFIGURE_METHODS: 'configureMethods',
            CREATE_TEMPLATE: 'createTemplate'
        };

        function onRequest(context) {
            const request = context.request;
            const action = request.parameters.custpage_action;

            try {
                if (request.method !== 'POST') {
                    context.response.writePage(buildSetupForm());
                    return;
                }

                // "Check All States"/"Deselect All States" submit buttons (see
                // buildScopeStatesForm()) are extra, uniquely-named submit controls on the
                // STEP 2B page -- only the specific one actually clicked has its name/value
                // pair ride along in the POST body (a plain HTML behavior, not something
                // requiring any client-side script), so the hidden custpage_action field's own
                // value (still CONFIGURE_METHODS on this page) never gets a chance to fire;
                // this check runs first and short-circuits it.
                const paramKeys = Object.keys(request.parameters);
                const markAllTriggerKey = paramKeys.find((key) => key.startsWith('custpage_markall_trigger_'));
                const deselectAllTriggerKey = paramKeys.find((key) => key.startsWith('custpage_deselectall_trigger_'));
                if (markAllTriggerKey) {
                    handleForceStatesRoundTrip(context, markAllTriggerKey.slice('custpage_markall_trigger_'.length), 'T');
                } else if (deselectAllTriggerKey) {
                    handleForceStatesRoundTrip(context, deselectAllTriggerKey.slice('custpage_deselectall_trigger_'.length), 'F');
                } else if (action === ACTION.CHOOSE_REGIONS) {
                    handleChooseRegions(context);
                } else if (action === ACTION.SCOPE_STATES) {
                    handleScopeStates(context);
                } else if (action === ACTION.CONFIGURE_METHODS) {
                    handleConfigureMethods(context);
                } else if (action === ACTION.CREATE_TEMPLATE) {
                    handleCreateTemplate(context);
                } else {
                    context.response.writePage(buildSetupForm('Unknown action -- please start again.'));
                }
            } catch (e) {
                log.error('Shipping template - unhandled error', {
                    action, errorName: e && e.name, errorMessage: e && e.message
                });
                context.response.writePage(buildResultPage({ success: false, message: e && e.message, correlationId: null }));
            }
        }

        /** STEP 1: template-level fields + how many shipping methods to configure next. */
        function buildSetupForm(errorMessage) {
            const form = serverWidget.createForm({ title: 'Create Walmart Shipping Template' });
            if (errorMessage) {
                form.addPageInitMessage({ type: message.Type.ERROR, title: 'Error', message: errorMessage });
            }
            const group = addSingleColumnGroup(form, 'custpage_setup_group');

            const nameField = form.addField({ id: 'custpage_name', type: serverWidget.FieldType.TEXT, label: 'Template Name', container: group });
            nameField.isMandatory = true;

            const typeField = form.addField({ id: 'custpage_type', type: serverWidget.FieldType.TEXT, label: 'Type (CUSTOM, or 3PL value -- confirm with Walmart)', container: group });
            typeField.defaultValue = 'CUSTOM';
            typeField.isMandatory = true;

            const rateModelField = form.addField({ id: 'custpage_rate_model_type', type: serverWidget.FieldType.SELECT, label: 'Rate Model Type', container: group });
            Object.keys(RATE_MODEL_TYPES).forEach((key) => rateModelField.addSelectOption({ value: key, text: RATE_MODEL_TYPES[key] }));
            rateModelField.isMandatory = true;

            const statusField = form.addField({ id: 'custpage_status', type: serverWidget.FieldType.SELECT, label: 'Template Status', container: group });
            Object.keys(TEMPLATE_STATUSES).forEach((key) => statusField.addSelectOption({ value: key, text: TEMPLATE_STATUSES[key], isSelected: key === 'ACTIVE' }));

            const shippingTypeField = form.addField({ id: 'custpage_shipping_type', type: serverWidget.FieldType.SELECT, label: 'Shipping Type', container: group });
            Object.keys(SHIPPING_TYPES).forEach((key) => shippingTypeField.addSelectOption({ value: key, text: SHIPPING_TYPES[key] }));

            const fulfillmentCentersField = form.addField({
                id: 'custpage_fulfillment_center_ids', type: serverWidget.FieldType.TEXT,
                label: 'Fulfillment Center IDs (comma-separated, only used when Shipping Type is International)', container: group
            });

            form.addField({ id: 'custpage_methods_label', type: serverWidget.FieldType.LABEL, label: 'Shipping Methods To Include', container: group });
            const methodsNoteField = form.addField({ id: 'custpage_methods_note', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
            methodsNoteField.defaultValue = '<p style="margin:2px 0 12px;font-size:12px;color:#666;">'
                + '<strong>Walmart requires every template to include a STANDARD shipping method.</strong> '
                + 'Each method checked here can have up to ' + MAX_CONFIGS_PER_METHOD + ' independent region/pricing '
                + 'configurations, set up in the next steps. Every template also gets a free VALUE shipping '
                + 'fallback covering the whole 48-state region and AK/HI automatically, whether or not '
                + 'VALUE shipping is checked here -- so every template always has a shipping option for all 50 '
                + 'states, even if the methods configured below only cover part of the country.</p>';
            METHOD_KEYS.forEach((key) => {
                const checkboxField = form.addField({ id: 'custpage_method_' + key.toLowerCase(), type: serverWidget.FieldType.CHECKBOX, label: SHIP_METHODS[key], container: group });
                checkboxField.defaultValue = key === 'STANDARD' ? 'T' : 'F';
                const statusField = form.addField({ id: 'custpage_method_status_' + key.toLowerCase(), type: serverWidget.FieldType.SELECT, label: `${SHIP_METHODS[key]} Status`, container: group });
                Object.keys(TEMPLATE_STATUSES).forEach((sKey) => statusField.addSelectOption({ value: sKey, text: TEMPLATE_STATUSES[sKey], isSelected: sKey === 'ACTIVE' }));
            });

            form.addSubmitButton({ label: 'Next: Choose Regions' });
            const actionField = form.addField({ id: 'custpage_action', type: serverWidget.FieldType.TEXT, label: 'Action', container: group });
            actionField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            actionField.defaultValue = ACTION.CHOOSE_REGIONS;
            return form;
        }

        /** Fields common to every step after setup -- carried forward, re-validated at each step. */
        const SETUP_FIELD_IDS = [
            'custpage_name', 'custpage_type', 'custpage_rate_model_type', 'custpage_status',
            'custpage_shipping_type', 'custpage_fulfillment_center_ids'
        ]
            .concat(METHOD_KEYS.map((key) => 'custpage_method_' + key.toLowerCase()))
            .concat(METHOD_KEYS.map((key) => 'custpage_method_status_' + key.toLowerCase()));

        /** Which method keys were checked in STEP 1 -- works against any params object that carries those checkboxes forward. */
        function getIncludedMethods(p) {
            return METHOD_KEYS.filter((key) => p['custpage_method_' + key.toLowerCase()] === 'T');
        }

        function addHiddenFields(form, group, pairs) {
            pairs.forEach(([id, value]) => {
                const f = form.addField({ id, type: serverWidget.FieldType.TEXT, label: id, container: group });
                f.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
                f.defaultValue = value || '';
            });
        }

        /** STEP 1 -> STEP 2: validate setup fields, render the top-level region picker. */
        function handleChooseRegions(context) {
            const p = context.request.parameters;
            if (!p.custpage_name || !p.custpage_rate_model_type) {
                context.response.writePage(buildSetupForm('Template Name and Rate Model Type are required.'));
                return;
            }
            if (!getIncludedMethods(p).includes('STANDARD')) {
                context.response.writePage(buildSetupForm('Walmart requires every template to include a STANDARD shipping method.'));
                return;
            }
            context.response.writePage(buildChooseRegionsForm(p));
        }

        /**
         * STEP 2: for each shipping method checked in STEP 1, pick which top-level region(s)
         * apply to each of up to MAX_CONFIGS_PER_METHOD independent configurations for that
         * method -- Walmart lets one method carry several region/pricing variants, so this
         * renders that many region-picker slots per method rather than a single one. Only the
         * first slot per method defaults to region "C" checked; the rest start blank and only
         * matter if the seller wants more than one configuration for that method. A slot left
         * with every region box unchecked is simply unused. Checking "C" for a slot is what
         * gates that slot's own section in STEP 2B (buildScopeStatesForm) below.
         */
        function buildChooseRegionsForm(setupParams, errorMessage) {
            const form = serverWidget.createForm({ title: `Choose Regions -- "${setupParams.custpage_name}"` });
            if (errorMessage) {
                form.addPageInitMessage({ type: message.Type.ERROR, title: 'Error', message: errorMessage });
            }
            const group = addSingleColumnGroup(form, 'custpage_regions_group');

            addHiddenFields(form, group, SETUP_FIELD_IDS.map((id) => [id, setupParams[id]]));

            const instructionsField = form.addField({ id: 'custpage_regions_instructions', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
            instructionsField.defaultValue = `<p>Each shipping method below can have up to ${MAX_CONFIGS_PER_METHOD} independent `
                + 'configurations (different regions and pricing each) -- most methods only need the first one. Leave a '
                + 'configuration\'s regions entirely unchecked to skip it. Checking <strong>48 State</strong> for a '
                + 'configuration gives you the option next to narrow it down to specific states.</p>';

            getIncludedMethods(setupParams).forEach((methodKey) => {
                const methodHeadingField = form.addField({ id: 'custpage_method_section_' + methodKey.toLowerCase(), type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
                methodHeadingField.defaultValue = `<h2 style="margin:28px 0 8px;padding-bottom:6px;border-bottom:2px solid #000;`
                    + `color:#000;font-size:22px;font-weight:bold;">${SHIP_METHODS[methodKey]}</h2>`;

                for (let c = 0; c < MAX_CONFIGS_PER_METHOD; c++) {
                    const suffix = `${methodKey.toLowerCase()}_${c}`;
                    const headingField = form.addField({ id: 'custpage_topregion_heading_' + suffix, type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
                    headingField.defaultValue = `<h3 style="margin:16px 0 4px;border-top:1px solid #ddd;padding-top:12px;">`
                        + `Configuration ${c + 1} of ${MAX_CONFIGS_PER_METHOD} -- Regions</h3>`;
                    Object.keys(REGION_CODES).forEach((key) => {
                        const f = form.addField({ id: `custpage_topregion_${key.toLowerCase()}_${suffix}`, type: serverWidget.FieldType.CHECKBOX, label: `${key} -- ${REGION_CODES[key]}`, container: group });
                        f.defaultValue = (key === 'C' && c === 0) ? 'T' : 'F';
                    });
                }
            });

            form.addSubmitButton({ label: 'Next' });
            const actionField = form.addField({ id: 'custpage_action', type: serverWidget.FieldType.TEXT, label: 'Action', container: group });
            actionField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            actionField.defaultValue = ACTION.SCOPE_STATES;
            return form;
        }

        /**
         * STEP 2 -> STEP 2B (or straight to STEP 3 if no configuration chose 48 State): read
         * every method's configuration slots. A slot with no region checked at all is unused
         * and dropped from here on, the same way a blank tier row is dropped later -- only
         * slots with at least one region checked continue. Each method checked in STEP 1 needs
         * at least one non-blank slot, checked here rather than waiting until final submit.
         * Only renders a state/stateSubregion narrowing section (buildScopeStatesForm) for
         * whichever specific slots checked "C".
         */
        function handleScopeStates(context) {
            const p = context.request.parameters;
            if (!p.custpage_name || !p.custpage_rate_model_type) {
                context.response.writePage(buildSetupForm('Template Name and Rate Model Type are required.'));
                return;
            }

            const includedMethods = getIncludedMethods(p);
            const slots = [];
            includedMethods.forEach((methodKey) => {
                for (let c = 0; c < MAX_CONFIGS_PER_METHOD; c++) {
                    const regionCodes = Object.keys(REGION_CODES).filter((key) => p[`custpage_topregion_${key.toLowerCase()}_${methodKey.toLowerCase()}_${c}`] === 'T');
                    if (regionCodes.length) slots.push({ methodKey, configIndex: c, regionCodes });
                }
            });

            const missingMethod = includedMethods.find((methodKey) => !slots.some((slot) => slot.methodKey === methodKey));
            if (missingMethod) {
                context.response.writePage(buildChooseRegionsForm(p, `${SHIP_METHODS[missingMethod] || missingMethod}: at least one configuration needs a region checked.`));
                return;
            }

            const scopeSlots = slots.filter((slot) => slot.regionCodes.includes('C'));

            if (scopeSlots.length) {
                context.response.writePage(buildScopeStatesForm(p, slots, scopeSlots));
            } else {
                context.response.writePage(buildMethodsForm(buildMethodsSetupFromParams(p, slots)));
            }
        }

        /**
         * STEP 2B -> STEP 2B: re-renders the SAME page after a "Check All States" or
         * "Deselect All States" submit button was clicked (see buildScopeStatesForm()) -- a
         * plain HTML round trip, not a client-side toggle. `p` already carries every field
         * this page needs, the same way handleScopeStates()'s `p` does, since it's just this
         * same page submitting to itself. `forceValue` is 'T' for Check All, 'F' for Deselect
         * All -- either way, the triggered slot's subregion-narrowing boxes are cleared too
         * (see buildScopeStatesForm()), since both actions reset that slot back to a single,
         * unambiguous state (fully covered, or blank).
         */
        function handleForceStatesRoundTrip(context, forceSuffix, forceValue) {
            const p = context.request.parameters;
            if (!p.custpage_name || !p.custpage_rate_model_type) {
                context.response.writePage(buildSetupForm('Template Name and Rate Model Type are required.'));
                return;
            }

            const slots = collectSlotsFromHiddenFields(p);
            const scopeSlots = slots.filter((slot) => slot.regionCodes.includes('C'));
            context.response.writePage(buildScopeStatesForm(p, slots, scopeSlots, { requestParams: p, forceSuffix, forceValue }));
        }

        /**
         * STEP 2B (one section per configuration slot that checked "C" -- 48 State -- in
         * STEP 2): lets each such slot be narrowed down to specific states/stateSubregions
         * instead of applying to the whole 48-State region. Renders a COMPLETE picker per
         * slot here, not a shared candidate pool -- with several slots all needing narrowing
         * this page gets long (141 rows each), a deliberate trade-off for giving every
         * configuration its own independent scope.
         */
        function buildScopeStatesForm(setupParams, slots, scopeSlots, options) {
            const { requestParams, forceSuffix, forceValue } = options || {};
            const form = serverWidget.createForm({ title: `Choose Region Scope -- "${setupParams.custpage_name}"` });
            const group = addSingleColumnGroup(form, 'custpage_scope_group');

            addHiddenFields(form, group, SETUP_FIELD_IDS.map((id) => [id, setupParams[id]])
                .concat(slots.map((slot) => [`custpage_top_regions_${slot.methodKey.toLowerCase()}_${slot.configIndex}`, slot.regionCodes.join(',')])));

            const instructionsField = form.addField({ id: 'custpage_scope_instructions', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
            instructionsField.defaultValue = '<p>The configuration(s) below chose 48 State as one of their regions. '
                + '<strong>Only check states for a configuration if it needs to be scoped to specific states.</strong> '
                + 'Leave every box unchecked for a configuration to keep it applying to all 48 contiguous states. '
                + 'Each configuration has <strong>Check All States</strong> and <strong>Deselect All States</strong> '
                + 'buttons. Check All is a quick way to build a "everything except a few states" configuration: '
                + 'click it, then uncheck just the states that need different terms.</p>';

            // scopeSlots is already grouped by method (built by iterating methods outer,
            // configurations inner) -- a new heading is inserted only when the method actually
            // changes, same large-heading treatment as buildChooseRegionsForm's method sections.
            // scopedCountByMethod/scopedIndexByMethod renumber each method's scoped slots 1..N
            // among just THAT method's scoped configurations, not against MAX_CONFIGS_PER_METHOD --
            // most methods only scope one or two of their configurations, so "1 of 6" would read
            // as if 5 more scoped sections were coming for this method when there aren't.
            const scopedCountByMethod = {};
            scopeSlots.forEach((slot) => { scopedCountByMethod[slot.methodKey] = (scopedCountByMethod[slot.methodKey] || 0) + 1; });

            let lastMethodKey = null;
            const scopedIndexByMethod = {};
            scopeSlots.forEach((slot) => {
                if (slot.methodKey !== lastMethodKey) {
                    lastMethodKey = slot.methodKey;
                    const methodHeadingField = form.addField({ id: 'custpage_scope_method_section_' + slot.methodKey.toLowerCase(), type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
                    methodHeadingField.defaultValue = `<h2 style="margin:28px 0 8px;padding-bottom:6px;border-bottom:2px solid #000;`
                        + `color:#000;font-size:22px;font-weight:bold;">${SHIP_METHODS[slot.methodKey]}</h2>`;
                }
                scopedIndexByMethod[slot.methodKey] = (scopedIndexByMethod[slot.methodKey] || 0) + 1;

                const suffix = `${slot.methodKey.toLowerCase()}_${slot.configIndex}`;
                const headingField = form.addField({ id: 'custpage_scope_heading_' + suffix, type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
                headingField.defaultValue = `<h3 style="margin:16px 0 4px;border-top:1px solid #ddd;padding-top:12px;">`
                    + `Configuration ${scopedIndexByMethod[slot.methodKey]} of ${scopedCountByMethod[slot.methodKey]} -- Region Scope</h3>`;

                // "Select All States" and "Deselect All States" buttons 
                const forceButtonsField = form.addField({ id: 'custpage_forcebuttons_html_' + suffix, type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
                forceButtonsField.defaultValue = `<input type="submit" name="custpage_markall_trigger_${suffix}" value="Check All States" `
                    + `style="margin:4px 6px 10px 0;padding:6px 14px;background:#2e7d32;color:#fff;font-weight:bold;`
                    + `font-size:12px;border:none;border-radius:3px;cursor:pointer;">`
                    + `<input type="submit" name="custpage_deselectall_trigger_${suffix}" value="Deselect All States" `
                    + `style="margin:4px 0 10px;padding:6px 14px;background:#666;color:#fff;font-weight:bold;`
                    + `font-size:12px;border:none;border-radius:3px;cursor:pointer;">`;

                Object.keys(STATES_BY_SUBREGION).forEach((subRegion) => {
                    const subRegionHeadingField = form.addField({
                        // NetSuite field ids must be lowercase -- subRegion/state codes are all
                        // uppercase (e.g. "NE", "CA"), so every id built from one is .toLowerCase()'d.
                        id: `custpage_subregion_label_${subRegion.toLowerCase()}_${suffix}`, type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group
                    });
                    subRegionHeadingField.defaultValue = `<h4 style="margin:14px 0 6px;font-size:14px;font-weight:bold;color:#000;">`
                        + `${SUBREGION_DISPLAY_NAMES[subRegion] || subRegion} (${subRegion})</h4>`;
                    STATES_BY_SUBREGION[subRegion].forEach((state) => {
                        form.addField({
                            id: `custpage_state_heading_${state.toLowerCase()}_${suffix}`, type: serverWidget.FieldType.LABEL,
                            label: `${state} -- ${STATE_NAMES[state] || state}`, container: group
                        });
                        // Whole-state option -- sends {stateCode, stateName} with NO stateSubregions
                        // array, per the schema's own "stateSubregions (optional)" note. Checking
                        // this AND any individual stateSubregion box below for the SAME state is
                        // rejected in buildNarrowedRegionEntry() rather than silently picking one.
                        // Sticky: on a normal render (fresh from STEP 2) requestParams has none of
                        // these keys, so every box defaults unchecked same as always; on a "Check
                        // All States"/"Deselect All States" round trip, this slot's boxes force to
                        // forceValue regardless of their prior state, while every OTHER slot's
                        // boxes read back whatever the user had already set on this same page, so
                        // their in-progress choices survive.
                        const isForcedSlot = suffix === forceSuffix;
                        const wholeStateFieldId = `custpage_wholestate_${state.toLowerCase()}_${suffix}`;
                        form.addField({
                            id: wholeStateFieldId, type: serverWidget.FieldType.CHECKBOX,
                            label: `All ${state} sub regions`, container: group
                        }).defaultValue = isForcedSlot ? forceValue : ((requestParams && requestParams[wholeStateFieldId] === 'T') ? 'T' : 'F');

                        if (STATE_SUBREGIONS_BY_STATE[state].length > 1) {
                            STATE_SUBREGIONS_BY_STATE[state].forEach((sub) => {
                                const subFieldId = `custpage_sub_${sub.code.toLowerCase()}_${suffix}`;
                                // Always cleared (not sticky) for the forced slot -- Check All
                                // shouldn't leave stale checked subregion boxes alongside a
                                // force-checked whole state (buildNarrowedRegionEntry() rejects
                                // having both), and Deselect All should reset narrowing entirely.
                                form.addField({
                                    id: subFieldId, type: serverWidget.FieldType.CHECKBOX,
                                    label: sub.name, container: group
                                }).defaultValue = (!isForcedSlot && requestParams && requestParams[subFieldId] === 'T') ? 'T' : 'F';
                            });
                        }
                    });
                });
            });

            form.addSubmitButton({ label: 'Next: Configure Shipping Methods' });
            const actionField = form.addField({ id: 'custpage_action', type: serverWidget.FieldType.TEXT, label: 'Action', container: group });
            actionField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            actionField.defaultValue = ACTION.CONFIGURE_METHODS;
            return form;
        }

        /** STEP 2B -> STEP 3: carry setup fields + every slot's chosen regions forward, render one block per active slot. */
        function handleConfigureMethods(context) {
            const p = context.request.parameters;
            if (!p.custpage_name || !p.custpage_rate_model_type) {
                context.response.writePage(buildSetupForm('Template Name and Rate Model Type are required.'));
                return;
            }

            context.response.writePage(buildMethodsForm(buildMethodsSetupFromParams(p, collectSlotsFromHiddenFields(p))));
        }

        /**
         * Reconstructs every active configuration slot from the `custpage_top_regions_<method>_<c>`
         * hidden fields carried forward since STEP 2B -- a slot whose hidden field is missing or
         * empty was never checked with a region and stays excluded, same as before. Used both when
         * STEP 3 is first rendered and again at final submit (buildTemplatePayload), so both read
         * the exact same set of slots.
         */
        function collectSlotsFromHiddenFields(p) {
            const slots = [];
            METHOD_KEYS.forEach((methodKey) => {
                for (let c = 0; c < MAX_CONFIGS_PER_METHOD; c++) {
                    const regionCodes = (p[`custpage_top_regions_${methodKey.toLowerCase()}_${c}`] || '').split(',').map((s) => s.trim()).filter(Boolean);
                    if (regionCodes.length) slots.push({ methodKey, configIndex: c, regionCodes });
                }
            });
            return slots;
        }

        /**
         * The actual state/stateSubregion checkbox choices are answered on the STEP 2B page,
         * but only read back when STEP 3 submits (buildNarrowedRegionEntry(), at that point) --
         * so every checked wholestate/sub box has to ride through STEP 3 as its own hidden
         * field, carrying the exact same field id, or the choice is silently lost between the
         * two pages. Only checked boxes need carrying -- an absent field reads the same as an
         * unchecked one.
         */
        function collectNarrowingHiddenFields(p) {
            return Object.keys(p)
                .filter((key) => (key.startsWith('custpage_wholestate_') || key.startsWith('custpage_sub_')) && p[key] === 'T')
                .map((key) => [key, 'T']);
        }

        /** Shared by both paths into STEP 3 (with or without STEP 2B in between). */
        function buildMethodsSetupFromParams(p, slots) {
            const includedMethods = getIncludedMethods(p);
            return {
                name: p.custpage_name,
                type: p.custpage_type,
                rateModelType: p.custpage_rate_model_type,
                status: p.custpage_status,
                shippingType: p.custpage_shipping_type,
                fulfillmentCenterIds: p.custpage_fulfillment_center_ids,
                includedMethods,
                methodStatusFields: includedMethods.map((key) => [`custpage_method_status_${key.toLowerCase()}`, p[`custpage_method_status_${key.toLowerCase()}`] || 'ACTIVE']),
                slots,
                narrowingFields: collectNarrowingHiddenFields(p)
            };
        }

        function buildMethodsForm(setup) {
            const form = serverWidget.createForm({ title: `Configure Shipping Methods -- "${setup.name}"` });
            const group = addSingleColumnGroup(form, 'custpage_methods_group');
            const slots = setup.slots || [];

            // Carried through as hidden fields -- re-validated in
            // buildTemplatePayload() when this step submits. narrowingFields re-carries whatever
            // state/stateSubregion boxes were checked back on the STEP 2B page -- this page never
            // re-renders them, so without this they'd be lost by the time this step submits.
            addHiddenFields(form, group, [
                ['custpage_name', setup.name], ['custpage_type', setup.type],
                ['custpage_rate_model_type', setup.rateModelType], ['custpage_status', setup.status],
                ['custpage_shipping_type', setup.shippingType],
                ['custpage_fulfillment_center_ids', setup.fulfillmentCenterIds]
            ]
                .concat((setup.includedMethods || []).map((key) => ['custpage_method_' + key.toLowerCase(), 'T']))
                .concat(setup.methodStatusFields || [])
                .concat(slots.map((slot) => [`custpage_top_regions_${slot.methodKey.toLowerCase()}_${slot.configIndex}`, slot.regionCodes.join(',')]))
                .concat(setup.narrowingFields || []));

            const isTiered = setup.rateModelType === 'TIERED_PRICING';
            const instructionsField = form.addField({ id: 'custpage_instructions', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
            instructionsField.defaultValue = `<p>Rate model: <strong>${RATE_MODEL_TYPES[setup.rateModelType] || setup.rateModelType}</strong>.</p>`
                + (isTiered
                    ? '<p>Fill in tier rows for each configuration -- minimum/maximum ITEM PRICE for that band (-1 max = unlimited), and the shipping charge for that price range. Leave a tier row completely blank to skip it.</p>'
                    : '<p>Fill in the per-shipment pricing fields for each configuration -- charge per pound of weight and/or a flat charge per item.</p>')
                + `<p style="font-size:12px;"><strong>Transit time per method:</strong> ${
                    Object.keys(SHIP_METHODS).map((key) => {
                        const rule = SHIP_METHOD_TRANSIT_TIME_DAYS[key];
                        const range = rule ? (rule.min === rule.max ? `${rule.min} day${rule.min === 1 ? '' : 's'}` : `${rule.min}-${rule.max} days`) : 'no fixed rule';
                        return `${SHIP_METHODS[key]} (${range})`;
                    }).join(', ')
                }. <br></br><strong>No shipping fee allowed for:</strong> ${
                    Object.keys(SHIP_METHODS).filter((key) => FREE_ONLY_SHIP_METHODS.includes(key)).map((key) => SHIP_METHODS[key]).join(', ') || 'none of the methods offered below'
                }.</p>`
                + '<p style="font-size:12px;">Each configuration\'s method, status, and regions (plus any state narrowing) were already chosen in the previous steps -- shown in each block\'s heading below, not re-editable here.</p>';

            // Turned into a Set once so buildMethodBlock() can cheaply check, per slot, which
            // wholestate/sub checkboxes were actually checked back on the STEP 2B page --
            // narrowingFields only carries the ones that were checked ('T'), see its own comment.
            const narrowingFieldIds = new Set((setup.narrowingFields || []).map(([id]) => id));

            // countByMethod/indexByMethod renumber each method's ACTIVE slots 1..N among just
            // that method's own slots -- same reason as STEP 2B's scopedCountByMethod: a method
            // whose active slots happen to be configIndex 0, 2, 4 (1 and 3 were left blank and
            // dropped) should read "Configuration 1 of 3" / "2 of 3" / "3 of 3" here, not
            // "1 of 3" / "3 of 3" / "5 of 3", which would look like a counting error.
            const countByMethod = {};
            slots.forEach((slot) => { countByMethod[slot.methodKey] = (countByMethod[slot.methodKey] || 0) + 1; });
            const indexByMethod = {};
            // slots is already grouped by method (built by iterating methods outer,
            // configurations inner) -- same large-heading-per-method break as STEP 2/STEP 2B,
            // inserted only when the method actually changes.
            let lastMethodKey = null;
            slots.forEach((slot) => {
                if (slot.methodKey !== lastMethodKey) {
                    lastMethodKey = slot.methodKey;
                    const methodHeadingField = form.addField({ id: 'custpage_config_method_section_' + slot.methodKey.toLowerCase(), type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
                    methodHeadingField.defaultValue = `<h2 style="margin:28px 0 8px;padding-bottom:6px;border-bottom:2px solid #000;`
                        + `color:#000;font-size:22px;font-weight:bold;">${SHIP_METHODS[slot.methodKey]}</h2>`;
                }
                indexByMethod[slot.methodKey] = (indexByMethod[slot.methodKey] || 0) + 1;
                buildMethodBlock(form, group, slot, isTiered, narrowingFieldIds, indexByMethod[slot.methodKey], countByMethod[slot.methodKey]);
            });

            form.addSubmitButton({ label: 'Create Shipping Template' });
            const actionField = form.addField({ id: 'custpage_action', type: serverWidget.FieldType.TEXT, label: 'Action', container: group });
            actionField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            actionField.defaultValue = ACTION.CREATE_TEMPLATE;

            const startOverField = form.addField({ id: 'custpage_start_over', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
            startOverField.defaultValue = '<div style="padding:10px 0;">'
                + `<a href="${buildSuiteletUrl()}" style="color:#666;font-size:13px;text-decoration:underline;">Start over</a>`
                + '</div>';

            return form;
        }

        /**
         * Renders one configuration slot -- no Ship Method or Method Status fields here
         * anymore, since a method now gets exactly one shippingMethods[] entry (chosen once in
         * STEP 1, together with its status) instead of one entry per slot -- see buildTemplatePayload()
         * for where slots sharing the same methodKey get grouped back into that one entry's
         * configurations[] array.
         */
        function buildMethodBlock(form, group, slot, isTiered, narrowingFieldIds, displayIndex, displayCount) {
            const suffix = `${slot.methodKey.toLowerCase()}_${slot.configIndex}`;
            const headingField = form.addField({ id: 'custpage_method_heading_' + suffix, type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
            const regionsSummary = slot.regionCodes.map((code) => `${code} -- ${REGION_CODES[code]}`).join(', ') || '(none)';
            // Only region "C" (48 State) can ever have a narrowed-states summary -- the other
            // 3 top-level regions have no state/stateSubregion breakdown at all.
            const narrowedSummary = slot.regionCodes.includes('C') ? buildNarrowedStatesSummary(narrowingFieldIds, suffix) : '';
            headingField.defaultValue = `<h3 style="margin:16px 0 4px;border-top:1px solid #ddd;padding-top:12px;">`
                + `Configuration ${displayIndex} of ${displayCount}</h3>`
                + `<p style="font-size:12px;color:#666;margin:0 0 8px;">Regions (chosen in the previous step): ${regionsSummary}`
                + (narrowedSummary ? ` -- 48 State narrowed to: ${narrowedSummary}` : '')
                + '</p>';

            form.addField({ id: 'custpage_addr_label_' + suffix, type: serverWidget.FieldType.LABEL, label: 'Address Type', container: group });
            Object.keys(ADDRESS_TYPES).forEach((key) => {
                const f = form.addField({ id: `custpage_addr_${key.toLowerCase()}_${suffix}`, type: serverWidget.FieldType.CHECKBOX, label: ADDRESS_TYPES[key], container: group });
                f.defaultValue = key === 'STREET' ? 'T' : 'F';
            });

            const transitTimeField = form.addField({ id: 'custpage_transit_time_' + suffix, type: serverWidget.FieldType.INTEGER, label: 'Transit Time (days)', container: group });
            transitTimeField.isMandatory = true;

            const currencyField = form.addField({ id: 'custpage_currency_' + suffix, type: serverWidget.FieldType.TEXT, label: 'Currency', container: group });
            currencyField.defaultValue = 'USD';

            if (isTiered) {
                for (let t = 0; t < MAX_TIERS; t++) {
                    const tierHeadingField = form.addField({ id: `custpage_tier_label_${suffix}_${t}`, type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
                    tierHeadingField.defaultValue = `<p style="margin:10px 0 0;font-weight:bold;">Tier ${t + 1}</p>`;
                    form.addField({ id: `custpage_tier_min_${suffix}_${t}`, type: serverWidget.FieldType.FLOAT, label: 'Item Price Min', container: group });
                    form.addField({ id: `custpage_tier_max_${suffix}_${t}`, type: serverWidget.FieldType.FLOAT, label: 'Item Price Max (-1 = Unlimited)', container: group });
                    form.addField({ id: `custpage_tier_charge_${suffix}_${t}`, type: serverWidget.FieldType.FLOAT, label: 'Shipping Charge', container: group });
                }
            } else {
                form.addField({ id: 'custpage_uom_' + suffix, type: serverWidget.FieldType.TEXT, label: 'Unit Of Measure (e.g. LB)', container: group }).defaultValue = 'LB';
                form.addField({ id: 'custpage_charge_handling_' + suffix, type: serverWidget.FieldType.FLOAT, label: 'Shipping And Handling Charge (blank = $0)', container: group });
                form.addField({ id: 'custpage_charge_weight_' + suffix, type: serverWidget.FieldType.FLOAT, label: 'Charge Per Weight (blank = $0)', container: group });
                form.addField({ id: 'custpage_charge_item_' + suffix, type: serverWidget.FieldType.FLOAT, label: 'Charge Per Item (blank = $0)', container: group });
            }
        }

        /** STEP 3 submit: build the full nested payload from every step's fields, POST to Walmart, log, show result. */
        function handleCreateTemplate(context) {
            const p = context.request.parameters;

            if (!p.custpage_name || !p.custpage_rate_model_type) {
                context.response.writePage(buildResultPage({ success: false, message: 'Missing template name or rate model type -- please start again.' }));
                return;
            }

            let payload;
            try {
                payload = buildTemplatePayload(p);
            } catch (e) {
                context.response.writePage(buildResultPage({ success: false, message: e.message }));
                return;
            }

            const ctx = getScriptParams();
            const baseUrl = BASE_URLS[ctx.environment] || BASE_URLS.SANDBOX;
            const correlationId = random.generateUUID();

            try {
                const accessToken = getWalmartAccessToken({ clientId: ctx.clientId, clientSecret: ctx.clientSecret, baseUrl, correlationId });
                const response = submitShippingTemplate({ accessToken, baseUrl, correlationId, environment: ctx.environment, payload });

                recordTemplateResult({
                    payload, status: RESULT_RECORD.STATUS.SUCCESS,
                    responseBody: response.body, correlationId
                });

                context.response.writePage(buildResultPage({
                    success: true,
                    message: `Shipping template "${payload.name}" submitted to Walmart (${response.code}).`,
                    correlationId,
                    responseBody: response.body
                }));
            } catch (e) {
                log.error('Failed to create Walmart shipping template', {
                    name: payload.name, errorName: e && e.name, errorMessage: e && e.message
                });
                recordTemplateResult({
                    payload, status: RESULT_RECORD.STATUS.ERROR,
                    errorMessage: e && e.message, correlationId
                });
                context.response.writePage(buildResultPage({ success: false, message: e && e.message, correlationId }));
            }
        }

        /**
         * Assembles the request body documented at developer.walmart.com/us-marketplace/
         * reference/createshippingtemplates. Walmart's schema gives each shipMethod exactly
         * ONE shippingMethods[] entry, but that entry's own `configurations` array can hold
         * several -- one per configuration slot the seller set up for that method in STEP 2/3.
         * Every active slot's `regions` array can itself hold several entries -- one per
         * checked top-level region code, plus an additive narrowed-region-C entry
         * (state/stateSubregion scoped) when any of those were checked for that slot. A tier
         * row needs all three of its fields filled in to be included; an entirely blank row is
         * silently dropped, and a partially-filled one throws.
         *
         * TIERED_PRICING tiers (minLimit/maxLimit/shipCharge) are ITEM-PRICE bands, not
         * weight/item-count bands
         * 
         * PER_SHIPMENT_PRICING's chargePerWeight/chargePerItem
         * cover weight- and item-count-based charging instead.
         */
        function buildTemplatePayload(p) {
            const rateModelType = p.custpage_rate_model_type;
            const isTiered = rateModelType === 'TIERED_PRICING';
            // Every state gets checked for every slot -- a slot that never got a STEP 2B
            // section (because it didn't check region "C") simply has none of these checkboxes
            // present, so they all read as unchecked and this naturally yields no narrowed entry.
            const allStateCodes = Object.keys(STATE_NAMES);

            const slots = collectSlotsFromHiddenFields(p);
            if (!slots.length) {
                throw new Error('At least one shipping method configuration (with a region checked) is required -- please start again.');
            }

            // Grouped by method -- every slot sharing a methodKey becomes one entry in that
            // method's own configurations[] array, rather than each slot becoming its own
            // shippingMethods[] entry (see this function's own header comment on why).
            const configurationsByMethod = {};

            // Same renumbering as buildMethodsForm()'s countByMethod/indexByMethod, so an error
            // message here says "configuration 2 of 3" matching the exact heading the user saw
            // on the pricing page, not the raw (and possibly non-contiguous) configIndex + 1.
            const countByMethod = {};
            slots.forEach((slot) => { countByMethod[slot.methodKey] = (countByMethod[slot.methodKey] || 0) + 1; });
            const indexByMethod = {};

            slots.forEach((slot) => {
                indexByMethod[slot.methodKey] = (indexByMethod[slot.methodKey] || 0) + 1;
                const suffix = `${slot.methodKey.toLowerCase()}_${slot.configIndex}`;
                const label = `${SHIP_METHODS[slot.methodKey] || slot.methodKey}, configuration ${indexByMethod[slot.methodKey]} of ${countByMethod[slot.methodKey]}`;
                const addressTypes = Object.keys(ADDRESS_TYPES).filter((key) => p[`custpage_addr_${key.toLowerCase()}_${suffix}`] === 'T');
                const transitTime = Number(p[`custpage_transit_time_${suffix}`]);
                const narrowedRegionC = buildNarrowedRegionEntry(p, allStateCodes, suffix);
                if ((!slot.regionCodes.length && !narrowedRegionC) || !transitTime) {
                    throw new Error(`${label}: at least one Region (or a narrowed state/stateSubregion) and a Transit Time are required.`);
                }

                // Transit time bounds per Walmart's Seller Center guide
                // // https://marketplacelearn.walmart.com/guides/Shipping%20&%20fulfillment/Shipping%20methods/Shipping-methods:-Overview
                const transitRule = SHIP_METHOD_TRANSIT_TIME_DAYS[slot.methodKey];
                if (transitRule && (transitTime < transitRule.min || transitTime > transitRule.max)) {
                    const expected = transitRule.min === transitRule.max ? `${transitRule.min} day(s)` : `${transitRule.min}-${transitRule.max} days`;
                    throw new Error(`${label}: transit time must be ${expected} -- got ${transitTime}.`);
                }

                const currency = p[`custpage_currency_${suffix}`] || 'USD';
                // A narrowed entry REPLACES the flat "C" entry, not adds to it -- flat "C" already
                // covers every state a narrowed entry could name, so keeping both would make the
                // narrowing a no-op (the configuration would still cover all 48 states regardless
                // of what was narrowed). Other checked region codes (H/P/A) have no narrowing
                // concept and are always included flat.
                const regions = slot.regionCodes
                    .filter((code) => code !== 'C' || !narrowedRegionC)
                    .map((code) => ({ regionCode: code, regionName: REGION_CODES[code] }));
                if (narrowedRegionC) regions.push(narrowedRegionC);
                const configuration = { regions, addressTypes, transitTime };

                if (isTiered) {
                    const tieredShippingCharges = [];
                    for (let t = 0; t < MAX_TIERS; t++) {
                        const min = p[`custpage_tier_min_${suffix}_${t}`];
                        const max = p[`custpage_tier_max_${suffix}_${t}`];
                        const charge = p[`custpage_tier_charge_${suffix}_${t}`];
                        if (min === '' && max === '' && charge === '') continue;
                        if (min === '' || max === '' || charge === '') {
                            throw new Error(`${label}, tier ${t + 1}: fill in Min, Max, and Charge together, or leave all three blank to skip this tier.`);
                        }
                        tieredShippingCharges.push({
                            minLimit: Number(min), maxLimit: Number(max),
                            shipCharge: { amount: Number(charge), currency }
                        });
                    }
                    if (!tieredShippingCharges.length) {
                        throw new Error(`${label}: at least one tiered shipping charge row is required for Tiered Pricing.`);
                    }
                    // Value/TwoDay can't charge a shipping fee.
                    if (FREE_ONLY_SHIP_METHODS.includes(slot.methodKey) && tieredShippingCharges.some((tier) => tier.shipCharge.amount !== 0)) {
                        throw new Error(`${label}: Walmart doesn't allow charging customers a shipping fee for this method -- every tier's Shipping Charge must be $0.`);
                    }
                    configuration.tieredShippingCharges = tieredShippingCharges;
                } else {
                    const handling = p[`custpage_charge_handling_${suffix}`];
                    const perWeight = p[`custpage_charge_weight_${suffix}`];
                    const perItem = p[`custpage_charge_item_${suffix}`];
                    
                    const perShippingCharge = {
                        unitOfMeasure: p[`custpage_uom_${suffix}`] || 'LB',
                        shippingAndHandling: { amount: handling !== '' ? Number(handling) : 0, currency },
                        chargePerWeight: { amount: perWeight !== '' ? Number(perWeight) : 0, currency },
                        chargePerItem: { amount: perItem !== '' ? Number(perItem) : 0, currency }
                    };
                    // Value/TwoDay can't charge a shipping fee.
                    if (FREE_ONLY_SHIP_METHODS.includes(slot.methodKey)) {
                        const totalCharge = perShippingCharge.shippingAndHandling.amount
                            + perShippingCharge.chargePerWeight.amount + perShippingCharge.chargePerItem.amount;
                        if (totalCharge !== 0) {
                            throw new Error(`${label}: Walmart doesn't allow charging customers a shipping fee for this method -- Shipping And Handling, Charge Per Weight, and Charge Per Item must all be $0.`);
                        }
                    }
                    configuration.perShippingCharge = perShippingCharge;
                }

                if (!configurationsByMethod[slot.methodKey]) configurationsByMethod[slot.methodKey] = [];
                configurationsByMethod[slot.methodKey].push(configuration);
            });

            // Every template gets a free VALUE shipping method as a fallback covering the whole 48-state region and
            // AK/HI, on top of whatever the seller configured (or didn't) for VALUE in the
            // wizard -- guarantees every template has at least one method covering all 50
            // states, so a SKU mapped to a template with only narrow coverage elsewhere still
            // has a shipping option for addresses outside that narrow area. Always appended,
            // regardless of whether VALUE was checked in STEP 1.
            if (!configurationsByMethod.VALUE) configurationsByMethod.VALUE = [];
            const existingValueConfigs = configurationsByMethod.VALUE;
            if (!hasExactFlatRegionConfig(existingValueConfigs, 'C')) {
                existingValueConfigs.push(buildFreeValueFallbackConfiguration('C', REGION_CODES.C, isTiered));
            }
            if (!hasExactFlatRegionConfig(existingValueConfigs, 'H')) {
                existingValueConfigs.push(buildFreeValueFallbackConfiguration('H', REGION_CODES.H, isTiered));
            }

            const shippingMethods = Object.keys(configurationsByMethod).map((methodKey) => {
                const configurations = dedupeConfigurations(configurationsByMethod[methodKey]);
                const overlapPair = findOverlappingConfigPair(configurations);
                if (overlapPair) {
                    throw new Error(`${SHIP_METHODS[methodKey] || methodKey}: two configurations cover overlapping geography with different `
                        + `terms, and Walmart doesn't document which would apply to an order in the overlap -- `
                        + `${describeConfigForError(overlapPair[0])} vs. ${describeConfigForError(overlapPair[1])}. `
                        + 'Please make their regions mutually exclusive or their terms identical.');
                }
                return {
                    shipMethod: methodKey,
                    status: p['custpage_method_status_' + methodKey.toLowerCase()] || 'ACTIVE',
                    configurations
                };
            });

            // Walmart requires every template to offer STANDARD shipping.
            if (!shippingMethods.some((m) => m.shipMethod === 'STANDARD')) {
                throw new Error('Walmart requires every template to include a STANDARD shipping method.');
            }

            const payload = {
                name: p.custpage_name,
                type: p.custpage_type || 'CUSTOM',
                rateModelType,
                status: p.custpage_status || 'ACTIVE',
                shippingMethods
            };
            if (p.custpage_shipping_type) payload.shippingType = p.custpage_shipping_type;
            if (p.custpage_fulfillment_center_ids) {
                payload.fulfillmentCenterIds = p.custpage_fulfillment_center_ids.split(',').map((s) => s.trim()).filter(Boolean);
            }
            return payload;
        }

        /**
         * Collapses byte-for-byte identical configurations within one method's configurations[]
         * array down to a single copy, keeping the first occurrence -- e.g. two configs that are
         * literally the same regions/addressTypes/transitTime/pricing, with nothing different
         * between them.
         */
        function dedupeConfigurations(configs) {
            const seen = new Set();
            return configs.filter((config) => {
                const key = JSON.stringify(config);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        }

        /**
         * True if `configs` already has a configuration whose ENTIRE regions[] array is just
         * one flat (no subRegions) entry for `regionCode` -- e.g. exactly `[{regionCode:"C",
         * regionName:"48 State"}]`, nothing narrowed and nothing else alongside it. Deliberately
         * narrow: this only catches an exact duplicate of what buildFreeValueFallbackConfiguration()
         * itself would produce, not any broader overlap (a config covering C AND H together, or a
         * narrowed subset of C, would NOT match here and would still get the fallback appended
         * alongside it -- the general overlapping-configurations problem is separate and unsolved).
         */
        function hasExactFlatRegionConfig(configs, regionCode) {
            return configs.some((config) => config.regions.length === 1
                && config.regions[0].regionCode === regionCode && !config.regions[0].subRegions);
        }

        /**
         * One configuration for the guaranteed free VALUE fallback (see buildTemplatePayload()'s
         * own comment on why every template gets these) -- always $0, since VALUE is in
         * FREE_ONLY_SHIP_METHODS and Walmart doesn't allow charging a fee for it. Uses the
         * template's own rateModelType, since that's a template-wide field rather than
         * something this fallback can pick independently.
         */
        function buildFreeValueFallbackConfiguration(regionCode, regionName, isTiered) {
            const configuration = {
                regions: [{ regionCode, regionName }],
                addressTypes: ['STREET'],
                transitTime: SHIP_METHOD_TRANSIT_TIME_DAYS.VALUE.max
            };
            if (isTiered) {
                configuration.tieredShippingCharges = [{ minLimit: 0, maxLimit: -1, shipCharge: { amount: 0, currency: 'USD' } }];
            } else {
                configuration.perShippingCharge = {
                    unitOfMeasure: 'LB',
                    shippingAndHandling: { amount: 0, currency: 'USD' },
                    chargePerWeight: { amount: 0, currency: 'USD' },
                    chargePerItem: { amount: 0, currency: 'USD' }
                };
            }
            return configuration;
        }

        /**
         * Expands one `regions[]` entry (as built above -- either a flat {regionCode} or a
         * narrowed "C" entry with subRegions[].states[]) into the set of leaf coverage units it
         * represents. Region "C" is broken down to stateSubregionCode, the finest granularity
         * this tool can express, so a flat 48-State entry and a narrowed TX_DALLAS-only entry
         * can be compared on the same footing. H/P/A have no further breakdown available, so
         * each is its own atomic leaf.
         */
        function getRegionLeaves(region) {
            if (region.regionCode !== 'C') return [`REGION:${region.regionCode}`];
            if (!region.subRegions) return ALL_C_LEAVES;
            const leaves = [];
            region.subRegions.forEach((subRegion) => {
                (subRegion.states || []).forEach((state) => {
                    if (state.stateSubregions && state.stateSubregions.length) {
                        state.stateSubregions.forEach((sub) => leaves.push(sub.stateSubregionCode));
                    } else {
                        (STATE_SUBREGIONS_BY_STATE[state.stateCode] || []).forEach((sub) => leaves.push(sub.code));
                    }
                });
            });
            return leaves;
        }

        /** Every leaf coverage unit across all of one configuration's regions[] entries. */
        function getConfigCoverageLeaves(config) {
            const leaves = new Set();
            (config.regions || []).forEach((region) => getRegionLeaves(region).forEach((leaf) => leaves.add(leaf)));
            return leaves;
        }

        /**
         * Finds the first pair of configurations (within one method's already-deduped
         * configurations[] array) whose geographic coverage overlaps -- regardless of how
         * differently each expresses it, e.g. a flat 48-State entry vs. a narrowed
         * TX_DALLAS-only entry. Byte-identical configurations are already collapsed by
         * dedupeConfigurations() before this runs, so any pair reaching this check is
         * guaranteed to differ in some way (price, transit time, address types, etc.) --
         * Walmart's docs never say which of two overlapping-but-different configurations
         * would actually apply to an order, so this is treated as a hard conflict rather
         * than guessed at.
         */
        function findOverlappingConfigPair(configs) {
            for (let i = 0; i < configs.length; i++) {
                const leavesA = getConfigCoverageLeaves(configs[i]);
                for (let j = i + 1; j < configs.length; j++) {
                    const leavesB = getConfigCoverageLeaves(configs[j]);
                    let overlaps = false;
                    for (const leaf of leavesA) {
                        if (leavesB.has(leaf)) { overlaps = true; break; }
                    }
                    if (overlaps) return [configs[i], configs[j]];
                }
            }
            return null;
        }

        /** Short regions + price description of a configuration, for a conflict error message. */
        function describeConfigForError(config) {
            const regions = (config.regions || []).map((r) => {
                if (r.regionCode !== 'C' || !r.subRegions) return REGION_CODES[r.regionCode] || r.regionCode;
                const states = [];
                r.subRegions.forEach((sr) => (sr.states || []).forEach((s) => states.push(s.stateCode)));
                return `48 State narrowed to ${states.join(', ')}`;
            }).join(' + ');
            const price = config.tieredShippingCharges
                ? config.tieredShippingCharges.map((t) => `$${t.shipCharge.amount} for ${t.minLimit}-${t.maxLimit === -1 ? 'unlimited' : t.maxLimit}`).join(', ')
                : `$${config.perShippingCharge.shippingAndHandling.amount} + $${config.perShippingCharge.chargePerWeight.amount}/lb + $${config.perShippingCharge.chargePerItem.amount}/item`;
            return `[${regions}] priced at ${price}`;
        }

        /**
         * Human-readable list of whichever states/stateSubregions were narrowed for this slot
         * on the STEP 2B page -- e.g. "TX (all subregions); CA (CA_LOS_ANGELES, CA_SAN_DIEGO)".
         * Display-only sibling of buildNarrowedRegionEntry() below (same field-id conventions,
         * same whole-state-vs-subregion logic), used to show the STEP 3 summary line rather
         * than to build the API payload. Returns '' if nothing was narrowed for this slot.
         */
        function buildNarrowedStatesSummary(narrowingFieldIds, suffix) {
            const parts = [];
            Object.keys(STATE_NAMES).forEach((state) => {
                const isWholeState = narrowingFieldIds.has(`custpage_wholestate_${state.toLowerCase()}_${suffix}`);
                const checkedSubs = (STATE_SUBREGIONS_BY_STATE[state] || [])
                    .filter((sub) => narrowingFieldIds.has(`custpage_sub_${sub.code.toLowerCase()}_${suffix}`));
                if (isWholeState) {
                    parts.push(`${state} (all subregions)`);
                } else if (checkedSubs.length) {
                    parts.push(`${state} (${checkedSubs.map((sub) => sub.name).join(', ')})`);
                }
            });
            return parts.join('; ');
        }

        /**
         * Builds ONE nested region-C entry ({regionCode:'C', regionName:'48 State',
         * subRegions:[...]}) from whichever stateSubregion checkboxes were checked for this
         * configuration slot, grouped subRegion -> state -> stateSubregions per the schema
         * (region.subRegions[].states[].stateSubregions[]).
         * `candidateStates` is every state to check -- a slot that never checked region "C"
         * in STEP 2 never got a STEP 2B section rendered for it, so every one of these
         * checkboxes simply doesn't exist for that slot and reads as unchecked, naturally
         * returning null. When non-null, buildTemplatePayload() uses this IN PLACE OF the flat
         * "C" entry for that slot, not alongside it -- a flat "C" entry already covers every
         * state this could name, so keeping both would make the narrowing have no actual effect
         * on the configuration's real coverage.
         */
        function buildNarrowedRegionEntry(p, candidateStates, suffix) {
            const subRegionsMap = {}; // subRegion code -> { subRegionCode, subRegionName, states: [] }
            candidateStates.forEach((state) => {
                const isWholeState = p[`custpage_wholestate_${state.toLowerCase()}_${suffix}`] === 'T';
                const checkedSubs = (STATE_SUBREGIONS_BY_STATE[state] || [])
                    .filter((sub) => p[`custpage_sub_${sub.code.toLowerCase()}_${suffix}`] === 'T');

                if (isWholeState && checkedSubs.length) {
                    throw new Error(`${STATE_NAMES[state] || state}: choose EITHER "All ${state} sub regions" OR specific subregion(s), not both.`);
                }
                if (!isWholeState && !checkedSubs.length) return;

                const subRegionCode = STATE_TO_SUBREGION[state];
                if (!subRegionsMap[subRegionCode]) {
                    subRegionsMap[subRegionCode] = { subRegionCode, subRegionName: subRegionCode, states: [] };
                }
                // Whole-state entry omits stateSubregions entirely (see the "Whole State"
                // checkbox's comment above) -- per the schema, that array is optional on a
                // state entry, the same way subRegions is optional on a region entry.
                const stateEntry = { stateCode: state, stateName: STATE_NAMES[state] || state };
                if (!isWholeState) {
                    stateEntry.stateSubregions = checkedSubs.map((sub) => ({ stateSubregionCode: sub.code, stateSubregionName: sub.name }));
                }
                subRegionsMap[subRegionCode].states.push(stateEntry);
            });

            const subRegions = Object.values(subRegionsMap);
            if (!subRegions.length) return null;
            return { regionCode: 'C', regionName: REGION_CODES.C, subRegions };
        }

        function submitShippingTemplate(params) {
            const { accessToken, baseUrl, correlationId, environment, payload } = params;

            const response = https.post({
                url: `${baseUrl}/v3/settings/shipping/templates`,
                body: JSON.stringify(payload),
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'WM_QOS.CORRELATION_ID': correlationId,
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            });

            logHttpResponse('Walmart create shipping template request', response, correlationId);
            if (response.code < 200 || response.code >= 300) {
                throw new Error(`Walmart create shipping template request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }
            return response;
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

        function recordTemplateResult(params) {
            const { payload, status, responseBody, errorMessage, correlationId } = params;
            const name = payload && payload.name;
            try {
                const rec = record.create({ type: RESULT_RECORD.TYPE, isDynamic: false });
                rec.setValue({ fieldId: RESULT_RECORD.FIELDS.NAME, value: name });
                rec.setValue({ fieldId: RESULT_RECORD.FIELDS.STATUS, value: status });
                rec.setValue({ fieldId: RESULT_RECORD.FIELDS.DATE_CREATED, value: new Date() });
                if (correlationId) rec.setValue({ fieldId: RESULT_RECORD.FIELDS.CORRELATION, value: correlationId });
                if (responseBody) rec.setValue({ fieldId: RESULT_RECORD.FIELDS.RESPONSE, value: String(responseBody).substring(0, 100000) });
                if (errorMessage) rec.setValue({ fieldId: RESULT_RECORD.FIELDS.ERROR, value: String(errorMessage).substring(0, 1000) });

                if (payload) {
                    rec.setValue({ fieldId: RESULT_RECORD.FIELDS.RATE_MODEL_TYPE, value: payload.rateModelType });
                    rec.setValue({ fieldId: RESULT_RECORD.FIELDS.TEMPLATE_TYPE, value: payload.type });
                    rec.setValue({ fieldId: RESULT_RECORD.FIELDS.TEMPLATE_STATUS, value: payload.status });
                    rec.setValue({ fieldId: RESULT_RECORD.FIELDS.SHIPPING_TYPE, value: payload.shippingType || 'DOMESTIC' });
                    const methodSummary = (payload.shippingMethods || []).map((m) => m.shipMethod).filter(Boolean).join(', ');
                    if (methodSummary) rec.setValue({ fieldId: RESULT_RECORD.FIELDS.METHOD_SUMMARY, value: methodSummary });
                }

                const templateId = extractTemplateId(responseBody);
                if (templateId) rec.setValue({ fieldId: RESULT_RECORD.FIELDS.TEMPLATE_ID, value: templateId });

                return rec.save({ enableSourcing: false, ignoreMandatoryFields: true });
            } catch (recordError) {
                log.error('Failed to write shipping template log record', {
                    name, errorMessage: recordError && recordError.message
                });
                return null;
            }
        }

        function extractTemplateId(responseBody) {
            if (!responseBody) return null;
            try {
                const parsed = JSON.parse(responseBody);
                return parsed.id || parsed.templateId || parsed.shippingTemplateId
                    || (parsed.payload && (parsed.payload.id || parsed.payload.templateId))
                    || null;
            } catch (e) {
                return null;
            }
        }

        function buildResultPage(params) {
            const { success, message, correlationId, responseBody } = params;
            const form = serverWidget.createForm({ title: success ? 'Shipping Template Created' : 'Shipping Template Failed' });
            const text = [
                success ? 'Success.' : 'Error.',
                message,
                correlationId ? `\n\ncorrelationId: ${correlationId} (reference this if you need to ask Walmart support about this template)` : '',
                responseBody ? `\n\nWalmart response:\n${responseBody}` : ''
            ].filter(Boolean).join(' ');

            const resultField = form.addField({ id: 'custpage_result', type: serverWidget.FieldType.LONGTEXT, label: 'Result' });
            resultField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
            resultField.defaultValue = text;

            const nextField = form.addField({ id: 'custpage_next', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
            nextField.defaultValue = '<div style="padding:10px 0;">'
                + `<a href="${buildSuiteletUrl()}" style="${BUTTON_STYLE}">Create another template</a>`
                + '</div>';

            return form;
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
