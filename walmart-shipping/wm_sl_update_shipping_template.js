/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * Ops tool for UPDATING an existing Walmart "Shipping Template" through Walmart's
 * Update Shipping Templates API -- PUT /v3/settings/shipping/templates/{templateId}.
 *
 * LOOK UP (read-only): the landing page offers a "Look Up Current
 * Template" button that GETs /v3/settings/shipping/templates/{templateId} and shows
 * Walmart's raw JSON for that template before you touch the wizard. This does NOT
 * populate the wizard's fields -- it only lets you see what's currently stored so you
 * know what to re-enter. The wizard itself is still a full-replacement PUT -- every
 * field must be re-entered by hand, exactly as intended, on every update -- any field
 * left at its default or filled in wrong will silently overwrite (not merge with)
 * whatever Walmart currently has stored for that template.
 *
 *   STEP 1 (SETUP): Template ID (new, required -- the Walmart template to overwrite) +
 *     template-level fields (name, type, rate model, status, optional international
 *     shipping type/fulfillment centers) and per-method checkboxes+status
 *     (VALUE/STANDARD/FREIGHT, STANDARD required).
 *   STEP 2 (CHOOSE REGIONS) / STEP 2B (SCOPE STATES) / STEP 3 (METHODS): one shipping
 *     method can carry several independent configurations (different regions/pricing
 *     each), each optionally narrowed to specific states/stateSubregions.
 *   Submitting STEP 3 builds the full nested payload (no templateId inside it, plus the
 *     guaranteed free VALUE fallback and duplicate-configuration collapsing) and PUTs it
 *     to /v3/settings/shipping/templates/{templateId}.
 *
 * Script parameters:
 *   custscript_wal_upd_ship_tmpl_client_id  - Walmart Marketplace API Client ID
 *   custscript_wal_upd_ship_tmpl_secret     - Walmart Marketplace API Client Secret (Password field type)
 *   custscript_wal_upd_ship_tmpl_env        - "PRODUCTION" or "SANDBOX"
 *
 * Logging: writes to customrecord_wal_shipping_templates -- there is no field on that
 * record distinguishing a create row from an update row. If that distinction is ever
 * needed, add a field for it; don't infer create-vs-update from existing fields.
 * 
 * TODO: inspecting and updating shipping templates might be easier using the seller center UI.
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
            CLIENT_ID: 'custscript_wal_upd_ship_tmpl_client_id',
            CLIENT_SECRET: 'custscript_wal_upd_ship_tmpl_secret',
            ENVIRONMENT: 'custscript_wal_upd_ship_tmpl_env'
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
        // Confirmed 2026-08-19 against the update endpoint's own docs (see file header) --
        // the create file still treats this as unconfirmed free text.
        const TEMPLATE_TYPES = { DEFAULT: 'Default', CUSTOM: 'Custom', DELIVERR: 'Deliverr' };
        const TEMPLATE_STATUSES = { ACTIVE: 'Active', INACTIVE: 'Inactive' };
        // THREE_DAY/TWO_DAY/ONE_DAY commented out -- these are expedited/performance-gated
        // programs, not freely selectable like VALUE/STANDARD/FREIGHT. Walmart only unlocks
        // them once a seller meets its performance criteria (on-time shipping/delivery rates,
        // etc.) -- see the expedited delivery programs guide:
        // https://marketplacelearn.walmart.com/guides/Shipping%20&%20fulfillment/Shipping%20methods/Shipping-methods:-expedited-delivery-programs
        // Re-enable the 3 commented lines below once that criteria is confirmed met/approved
        // for this seller account.
        const SHIP_METHODS = {
            VALUE: 'Value', STANDARD: 'Standard',
            // THREE_DAY: 'Three Day',
            // TWO_DAY: 'Two Day',
            // ONE_DAY: 'One Day',
            FREIGHT: 'Freight'
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
        // Same source -- "You can't charge customers a shipping fee when using Value/TwoDay
        // shipping." Standard/OneDay/Freight all explicitly allow charging OR free shipping.
        const FREE_ONLY_SHIP_METHODS = ['VALUE', 'TWO_DAY'];

        const ADDRESS_TYPES = { STREET: 'Street', PO_BOX: 'PO Box', MILITARY: 'Military (APO/FPO)' };
        const SHIPPING_TYPES = { '': '-- Domestic (default) --', INTERNATIONAL: 'International' };

        // https://developer.walmart.com/us-marketplace/docs/create-shipping-templates
        // These were the only region codes listed in Walmart's examples -- same table used
        // by the create Suitelet, confirmed to apply unchanged to update (identical schema).
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
         * https://developer.walmart.com/image/asdp/us/mp/settings/RegionMappingTable.xlsx
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
         * Derived from REGION_MAPPING_TABLE above:
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

        // Every method key gets exactly one shippingMethods[] entry in the payload.
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
                TEMPLATE_TYPE: 'custrecord_wal_shiptmpl_type',              // DEFAULT / CUSTOM / DELIVERR
                TEMPLATE_STATUS: 'custrecord_wal_shiptmpl_active_status',   // Walmart's OWN ACTIVE/INACTIVE status field, distinct from STATUS above
                SHIPPING_TYPE: 'custrecord_wal_shiptmpl_shipping_type',     // always set -- 'DOMESTIC' (this script's own label, not a Walmart enum value) or Walmart's 'INTERNATIONAL'
                METHOD_SUMMARY: 'custrecord_wal_shiptmpl_methods'           // comma list of shipMethod values included
            },
            STATUS: { SUCCESS: 'Success', ERROR: 'Error' }
        };

        const ACTION = {
            ENTRY_SUBMIT: 'entrySubmit',
            CHOOSE_REGIONS: 'chooseRegions',
            SCOPE_STATES: 'scopeStates',
            CONFIGURE_METHODS: 'configureMethods',
            UPDATE_TEMPLATE: 'updateTemplate'
        };

        /** Landing page's Action dropdown (buildEntryForm) -- read by handleEntrySubmit to decide where to route. */
        const INTENT = { LOOK_UP: 'lookUp', UPDATE: 'update' };

        function onRequest(context) {
            const request = context.request;
            const action = request.parameters.custpage_action;

            try {
                if (request.method !== 'POST') {
                    // "Update this template" link from the Look Up result page skips the
                    // landing page and jumps straight into the wizard with the Template ID
                    // already filled in.
                    const prefillTemplateId = request.parameters.custpage_prefill_template_id;
                    context.response.writePage(prefillTemplateId ? buildSetupForm(null, prefillTemplateId) : buildEntryForm());
                    return;
                }

                const paramKeys = Object.keys(request.parameters);
                const markAllTriggerKey = paramKeys.find((key) => key.startsWith('custpage_markall_trigger_'));
                const deselectAllTriggerKey = paramKeys.find((key) => key.startsWith('custpage_deselectall_trigger_'));
                if (markAllTriggerKey) {
                    handleForceStatesRoundTrip(context, markAllTriggerKey.slice('custpage_markall_trigger_'.length), 'T');
                } else if (deselectAllTriggerKey) {
                    handleForceStatesRoundTrip(context, deselectAllTriggerKey.slice('custpage_deselectall_trigger_'.length), 'F');
                } else if (action === ACTION.ENTRY_SUBMIT) {
                    handleEntrySubmit(context);
                } else if (action === ACTION.CHOOSE_REGIONS) {
                    handleChooseRegions(context);
                } else if (action === ACTION.SCOPE_STATES) {
                    handleScopeStates(context);
                } else if (action === ACTION.CONFIGURE_METHODS) {
                    handleConfigureMethods(context);
                } else if (action === ACTION.UPDATE_TEMPLATE) {
                    handleUpdateTemplate(context);
                } else {
                    context.response.writePage(buildSetupForm('Unknown action -- please start again.'));
                }
            } catch (e) {
                log.error('Update shipping template - unhandled error', {
                    action, errorName: e && e.name, errorMessage: e && e.message
                });
                context.response.writePage(buildResultPage({ success: false, message: e && e.message, correlationId: null }));
            }
        }

        /**
         * Landing page, shown on a fresh GET. A single Action dropdown (Look Up / Continue to
         * Update Wizard). Reads custpage_intent to decide whether to run the read-only GET 
         * (handleLookUpTemplate) or move on to STEP 1 (buildSetupForm).
         */
        function buildEntryForm(errorMessage) {
            const form = serverWidget.createForm({ title: 'Walmart Shipping Template Tool' });
            if (errorMessage) {
                form.addPageInitMessage({ type: message.Type.ERROR, title: 'Error', message: errorMessage });
            }
            const group = addSingleColumnGroup(form, 'custpage_entry_group');

            const introField = form.addField({ id: 'custpage_entry_intro', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
            introField.defaultValue = '<p>Look up an existing Walmart shipping template to see its current configuration '
                + '(read-only), or go straight to the update wizard. The wizard is a full-replacement PUT.</p>';

            const intentField = form.addField({ id: 'custpage_intent', type: serverWidget.FieldType.SELECT, label: 'What do you want to do?', container: group });
            intentField.addSelectOption({ value: INTENT.LOOK_UP, text: 'Look Up Template', isSelected: true });
            intentField.addSelectOption({ value: INTENT.UPDATE, text: 'Update Template' });

            form.addField({ id: 'custpage_template_id', type: serverWidget.FieldType.TEXT, label: 'Walmart Template ID', container: group });

            form.addSubmitButton({ label: 'Go' });
            const actionField = form.addField({ id: 'custpage_action', type: serverWidget.FieldType.TEXT, label: 'Action', container: group });
            actionField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            actionField.defaultValue = ACTION.ENTRY_SUBMIT;
            return form;
        }

        /** Landing page submit -- routes to the read-only lookup or into STEP 1 based on the custpage_intent dropdown. */
        function handleEntrySubmit(context) {
            const p = context.request.parameters;
            if (p.custpage_intent === INTENT.LOOK_UP) {
                handleLookUpTemplate(context);
            } else {
                context.response.writePage(buildSetupForm(null, p.custpage_template_id));
            }
        }

        /**
         * STEP 1: Template ID (new -- required, the existing Walmart template to overwrite) +
         * the same template-level fields as create. `prefillTemplateId` is set only when
         * arriving via the "Update this template" link on the Look Up result page -- it fills
         * in just that one field, nothing else; every other field still starts blank/default,
         * same as any other entry into this step.
         */
        function buildSetupForm(errorMessage, prefillTemplateId) {
            const form = serverWidget.createForm({ title: 'Update Walmart Shipping Template' });
            if (errorMessage) {
                form.addPageInitMessage({ type: message.Type.ERROR, title: 'Error', message: errorMessage });
            }
            const group = addSingleColumnGroup(form, 'custpage_setup_group');

            const templateIdField = form.addField({ id: 'custpage_template_id', type: serverWidget.FieldType.TEXT, label: 'Walmart Template ID (the template to overwrite)', container: group });
            templateIdField.isMandatory = true;
            if (prefillTemplateId) templateIdField.defaultValue = prefillTemplateId;
            const templateIdNoteField = form.addField({ id: 'custpage_template_id_note', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
            templateIdNoteField.defaultValue = '<p style="margin:2px 0 12px;font-size:12px;color:#666;">'
                + 'This PUTs a full replacement to Walmart -- every field below must be filled in exactly as you want the '
                + 'template to end up, not just the fields you\'re changing.</p>';

            const nameField = form.addField({ id: 'custpage_name', type: serverWidget.FieldType.TEXT, label: 'Template Name', container: group });
            nameField.isMandatory = true;

            const typeField = form.addField({ id: 'custpage_type', type: serverWidget.FieldType.SELECT, label: 'Type', container: group });
            Object.keys(TEMPLATE_TYPES).forEach((key) => typeField.addSelectOption({ value: key, text: TEMPLATE_TYPES[key], isSelected: key === 'CUSTOM' }));
            typeField.isMandatory = true;

            const rateModelField = form.addField({ id: 'custpage_rate_model_type', type: serverWidget.FieldType.SELECT, label: 'Rate Model Type', container: group });
            Object.keys(RATE_MODEL_TYPES).forEach((key) => rateModelField.addSelectOption({ value: key, text: RATE_MODEL_TYPES[key] }));
            rateModelField.isMandatory = true;

            const statusField = form.addField({ id: 'custpage_status', type: serverWidget.FieldType.SELECT, label: 'Status', container: group });
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
                + 'configurations, set up in the next steps. Every template also gets a free VALUE '
                + 'fallback covering the whole 48-state region and AK/HI automatically, whether or not '
                + 'VALUE is checked here -- so every template always has a shipping option for all 50 '
                + 'states, even if the methods configured below only cover part of the country. Remember, '
                + 'this is a full replacement of the existing template -- every method you want it to end '
                + 'up with must be checked here, not just the ones changing.</p>';
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

        /** Fields common to every step after setup -- carried forward, re-validated (not re-trusted) at each step. Template ID included, unlike create. */
        const SETUP_FIELD_IDS = [
            'custpage_template_id', 'custpage_name', 'custpage_type', 'custpage_rate_model_type', 'custpage_status',
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

        /** STEP 1 -> STEP 2: validate setup fields (now including Template ID), render the top-level region picker. */
        function handleChooseRegions(context) {
            const p = context.request.parameters;
            if (!p.custpage_template_id || !p.custpage_name || !p.custpage_rate_model_type) {
                context.response.writePage(buildSetupForm('Template ID, Template Name, and Rate Model Type are required.'));
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
         * renders that many region-picker slots per method.
         */
        function buildChooseRegionsForm(setupParams, errorMessage) {
            const form = serverWidget.createForm({ title: `Choose Regions -- "${setupParams.custpage_name}" (Template ${setupParams.custpage_template_id})` });
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
            if (!p.custpage_template_id || !p.custpage_name || !p.custpage_rate_model_type) {
                context.response.writePage(buildSetupForm('Template ID, Template Name, and Rate Model Type are required.'));
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
         * "Deselect All States" submit button was clicked. `forceValue` is 'T' for Check All, 'F' for 
         * Deselect All -- either way, the triggered slot's subregion-narrowing boxes are cleared too.
         */
        function handleForceStatesRoundTrip(context, forceSuffix, forceValue) {
            const p = context.request.parameters;
            if (!p.custpage_template_id || !p.custpage_name || !p.custpage_rate_model_type) {
                context.response.writePage(buildSetupForm('Template ID, Template Name, and Rate Model Type are required.'));
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
            const form = serverWidget.createForm({ title: `Choose Region Scope -- "${setupParams.custpage_name}" (Template ${setupParams.custpage_template_id})` });
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
                forceButtonsField.defaultValue = `<input type="submit" name="custpage_markall_trigger_${suffix}" value="Select All States" `
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
                        // array. Checking this AND any individual stateSubregion box below for the SAME state is
                        // rejected in buildNarrowedRegionEntry() rather than silently picking one.
                        const isForcedSlot = suffix === forceSuffix;
                        const wholeStateFieldId = `custpage_wholestate_${state.toLowerCase()}_${suffix}`;
                        form.addField({
                            id: wholeStateFieldId, type: serverWidget.FieldType.CHECKBOX,
                            label: `All ${state} sub regions`, container: group
                        }).defaultValue = isForcedSlot ? forceValue : ((requestParams && requestParams[wholeStateFieldId] === 'T') ? 'T' : 'F');

                        // Some states do not have subregions. eg. North Dakota, Nebraska, Washington
                        if (STATE_SUBREGIONS_BY_STATE[state].length > 1) {
                            STATE_SUBREGIONS_BY_STATE[state].forEach((sub) => {
                                const subFieldId = `custpage_sub_${sub.code.toLowerCase()}_${suffix}`;
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

        /** STEP 2B -> STEP 3: carry setup fields (incl. Template ID) + every slot's chosen regions forward, render one block per active slot. */
        function handleConfigureMethods(context) {
            const p = context.request.parameters;
            if (!p.custpage_template_id || !p.custpage_name || !p.custpage_rate_model_type) {
                context.response.writePage(buildSetupForm('Template ID, Template Name, and Rate Model Type are required.'));
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

        /** Shared by both paths into STEP 3 (with or without STEP 2B in between). Template ID rides along with the rest of setup. */
        function buildMethodsSetupFromParams(p, slots) {
            const includedMethods = getIncludedMethods(p);
            return {
                templateId: p.custpage_template_id,
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
            const form = serverWidget.createForm({ title: `Configure Shipping Methods -- "${setup.name}" (Template ${setup.templateId})` });
            const group = addSingleColumnGroup(form, 'custpage_methods_group');
            const slots = setup.slots || [];

            // Carried through as hidden fields -- re-validated in
            // buildTemplatePayload() when this step submits. narrowingFields re-carries whatever
            // state/stateSubregion boxes were checked back on the STEP 2B page -- this page never
            // re-renders them, so without this they'd be lost by the time this step submits.
            addHiddenFields(form, group, [
                ['custpage_template_id', setup.templateId],
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
                + '<p style="font-size:12px;">Each configuration\'s method, status, and regions (plus any state narrowing) were already chosen in the previous steps -- shown in each block\'s heading below, not re-editable here.</p>'
                + `<p style="font-size:12px;"><strong>This is a full replacement of Template ${setup.templateId}</strong> -- every method and configuration you want the template to end up with must be set up in the steps above, not just the ones changing.</p>`;

            // Turned into a Set once so buildMethodBlock() can cheaply check, per slot, which
            // wholestate/sub checkboxes were actually checked back on the STEP 2B page.
            const narrowingFieldIds = new Set((setup.narrowingFields || []).map(([id]) => id));

            // countByMethod/indexByMethod renumber each method's ACTIVE slots 1..N among just
            // that method's own slots.
            const countByMethod = {};
            slots.forEach((slot) => { countByMethod[slot.methodKey] = (countByMethod[slot.methodKey] || 0) + 1; });
            const indexByMethod = {};
            // slots is already grouped by method (built by iterating methods outer,
            // configurations inner).
            let lastMethodKey = null;
            slots.forEach((slot) => {
                if (slot.methodKey !== lastMethodKey) {
                    lastMethodKey = slot.methodKey;
                    const methodHeadingField = form.addField({ id: 'custpage_config_method_section_' + slot.methodKey.toLowerCase(), type: serverWidget.FieldType.INLINEHTML, label: ' ', container: group });
                    methodHeadingField.defaultValue = `<h2 style="margin:28px 0 8px;padding-bottom:6px;border-bottom:2px solid #000;`
                        + `color:#000;font-size:22px;font-weight:bold;">${SHIP_METHODS[slot.methodKey]} ${SHIP_METHOD_TRANSIT_TIME_DAYS[slot.methodKey].min}-${SHIP_METHOD_TRANSIT_TIME_DAYS[slot.methodKey].max} day transit</h2>`;
                }
                indexByMethod[slot.methodKey] = (indexByMethod[slot.methodKey] || 0) + 1;
                buildMethodBlock(form, group, slot, isTiered, narrowingFieldIds, indexByMethod[slot.methodKey], countByMethod[slot.methodKey]);
            });

            form.addSubmitButton({ label: 'Update Shipping Template' });
            const actionField = form.addField({ id: 'custpage_action', type: serverWidget.FieldType.TEXT, label: 'Action', container: group });
            actionField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            actionField.defaultValue = ACTION.UPDATE_TEMPLATE;

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

        /** STEP 3 submit: build the full nested payload from every step's fields, PUT to Walmart at /templates/{templateId}, log, show result. */
        function handleUpdateTemplate(context) {
            const p = context.request.parameters;
            const templateId = p.custpage_template_id;

            if (!templateId || !p.custpage_name || !p.custpage_rate_model_type) {
                context.response.writePage(buildResultPage({ success: false, message: 'Missing template ID, name, or rate model type -- please start again.' }));
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
                const response = submitShippingTemplateUpdate({ accessToken, baseUrl, correlationId, environment: ctx.environment, templateId, payload });

                recordTemplateResult({
                    templateId, payload, status: RESULT_RECORD.STATUS.SUCCESS,
                    responseBody: response.body, correlationId
                });

                context.response.writePage(buildResultPage({
                    success: true,
                    message: `Shipping template "${payload.name}" (Template ${templateId}) update submitted to Walmart (${response.code}).`,
                    correlationId,
                    responseBody: response.body
                }));
            } catch (e) {
                log.error('Failed to update Walmart shipping template', {
                    templateId, name: payload.name, errorName: e && e.name, errorMessage: e && e.message
                });
                recordTemplateResult({
                    templateId, payload, status: RESULT_RECORD.STATUS.ERROR,
                    errorMessage: e && e.message, correlationId
                });
                context.response.writePage(buildResultPage({ success: false, message: e && e.message, correlationId }));
            }
        }

        /**
         * Assembles the request body documented at developer.walmart.com/us-marketplace/
         * reference/updateshippingtemplates. Walmart's schema gives each shipMethod exactly ONE
         * shippingMethods[] entry, but that entry's own `configurations` array can hold several --
         * one per configuration slot the seller set up for that method in STEP 2/3. Every active
         * slot's `regions` array can itself hold several entries -- one per checked top-level
         * region code, plus an additive narrowed-region-C entry (state/stateSubregion scoped)
         * when any of those were checked for that slot. A tier row needs all three of its fields
         * filled in to be included; an entirely blank row is silently dropped, and a partially-
         * filled one throws.
         *
         * TIERED_PRICING tiers (minLimit/maxLimit/shipCharge) are ITEM-PRICE bands, not
         * weight/item-count bands -- PER_SHIPMENT_PRICING's chargePerWeight/chargePerItem
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
                // https://marketplacelearn.walmart.com/guides/Shipping%20&%20fulfillment/Shipping%20methods/Shipping-methods:-Overview
                const transitRule = SHIP_METHOD_TRANSIT_TIME_DAYS[slot.methodKey];
                if (transitRule && (transitTime < transitRule.min || transitTime > transitRule.max)) {
                    const expected = transitRule.min === transitRule.max ? `${transitRule.min} day(s)` : `${transitRule.min}-${transitRule.max} days`;
                    throw new Error(`${label}: transit time must be ${expected} -- got ${transitTime}.`);
                }

                const currency = p[`custpage_currency_${suffix}`] || 'USD';
                // A narrowed entry REPLACES the flat "C" entry, not adds to it -- flat "C" already
                // covers every state a narrowed entry could name, so keeping both would make the
                // narrowing a no-op (the configuration would still cover all 48 states regardless
                // of what was narrowed) and would always self-overlap under findOverlappingConfigPair().
                // Other checked region codes (H/P/A) have no narrowing concept and are always included flat.
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
                    // See FREE_ONLY_SHIP_METHODS' comment -- Value/TwoDay can't charge a fee at all.
                    if (FREE_ONLY_SHIP_METHODS.includes(slot.methodKey) && tieredShippingCharges.some((tier) => tier.shipCharge.amount !== 0)) {
                        throw new Error(`${label}: Walmart doesn't allow charging customers a shipping fee for this method -- every tier's Shipping Charge must be $0.`);
                    }
                    configuration.tieredShippingCharges = tieredShippingCharges;
                } else {
                    const handling = p[`custpage_charge_handling_${suffix}`];
                    const perWeight = p[`custpage_charge_weight_${suffix}`];
                    const perItem = p[`custpage_charge_item_${suffix}`];
                    // chargePerWeight/chargePerItem (and shippingAndHandling) are always sent, blank
                    // fields defaulting to amount 0, rather than omitted -- confirmed against the
                    // create endpoint's identical schema: leaving chargePerWeight out entirely (only
                    // shippingAndHandling filled in) got back a Walmart response about
                    // perShippingCharge.chargePerWeight.currency being empty. Walmart's own documented
                    // sample requests for this rate model always include all three keys too, several
                    // with amount 0 -- matching that shape here.
                    const perShippingCharge = {
                        unitOfMeasure: p[`custpage_uom_${suffix}`] || 'LB',
                        shippingAndHandling: { amount: handling !== '' ? Number(handling) : 0, currency },
                        chargePerWeight: { amount: perWeight !== '' ? Number(perWeight) : 0, currency },
                        chargePerItem: { amount: perItem !== '' ? Number(perItem) : 0, currency }
                    };
                    // Value/TwoDay can't charge a fee at all.
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

            // Every template gets a free VALUE fallback covering the whole 48-state region and
            // AK/HI, on top of whatever the seller configured (or didn't) for VALUE in the
            // wizard -- guarantees every template has at least one method covering all 50
            // states, so a SKU mapped to a template with only narrow coverage elsewhere still
            // has a shipping option for addresses outside that narrow area. This matters just as
            // much on update as on create -- a full-replacement PUT that omitted this fallback
            // would silently remove the 50-state guarantee from an existing template. Always
            // appended, regardless of whether VALUE was checked in STEP 1 -- EXCEPT skipped for
            // whichever of C/H the seller's own VALUE configuration already covers with an
            // identical flat (non-narrowed) entry, so a seller who manually builds the same free
            // 48-state/AK-HI coverage doesn't end up with an exact duplicate sitting next to this
            // fallback.
            if (!configurationsByMethod.VALUE) configurationsByMethod.VALUE = [];
            const existingValueConfigs = configurationsByMethod.VALUE;
            if (!hasExactFlatRegionConfig(existingValueConfigs, 'C')) {
                existingValueConfigs.push(buildFreeValueFallbackConfiguration('C', REGION_CODES.C, isTiered));
            }
            if (!hasExactFlatRegionConfig(existingValueConfigs, 'H')) {
                existingValueConfigs.push(buildFreeValueFallbackConfiguration('H', REGION_CODES.H, isTiered));
            }

            // Status is a method-level property in Walmart's schema (one value per
            // shippingMethods[] entry, not per configuration) -- asked once per method back in
            // STEP 1, not re-asked per slot. dedupeConfigurations() collapses any exact-duplicate
            // configurations within a method down to one -- whether that duplication came from
            // the seller's own wizard input or from the VALUE fallback injection above.
            // findOverlappingConfigPair() then catches the broader case dedupe can't: two
            // configurations that differ (price, transit time, etc.) but still geographically
            // overlap, which Walmart's docs never say how to resolve.
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
         * Collapses identical configurations within one method's configurations[]
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
         * alongside it) -- the broader overlapping-configurations problem is handled separately by
         * findOverlappingConfigPair() below, once all of a method's configurations are assembled.
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
         * would actually apply to an order, so this is treated as a hard conflict.
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
         * checkboxes simply doesn't exist for that slot and reads as unchecked, returning null. 
         * When non-null, buildTemplatePayload() uses this IN PLACE OF the flat
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
                // Whole-state entry omits stateSubregions entirely.
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

        /**
         * Read-only lookup, no pre-fill.
         */
        function handleLookUpTemplate(context) {
            const p = context.request.parameters;
            const templateId = p.custpage_template_id;
            if (!templateId) {
                context.response.writePage(buildEntryForm('Enter a Template ID to look up.'));
                return;
            }

            const ctx = getScriptParams();
            const baseUrl = BASE_URLS[ctx.environment] || BASE_URLS.SANDBOX;
            const correlationId = random.generateUUID();

            try {
                const accessToken = getWalmartAccessToken({ clientId: ctx.clientId, clientSecret: ctx.clientSecret, baseUrl, correlationId });
                const response = getShippingTemplateDetails({ accessToken, baseUrl, correlationId, environment: ctx.environment, templateId });
                context.response.writePage(buildLookupResultPage({ templateId, responseBody: response.body }));
            } catch (e) {
                log.error('Failed to look up Walmart shipping template', {
                    templateId, errorName: e && e.name, errorMessage: e && e.message
                });
                context.response.writePage(buildLookupResultPage({ templateId, errorMessage: e && e.message, correlationId }));
            }
        }

        function getShippingTemplateDetails(params) {
            const { accessToken, baseUrl, correlationId, environment, templateId } = params;

            const response = https.get({
                url: `${baseUrl}/v3/settings/shipping/templates/${encodeURIComponent(templateId)}`,
                headers: {
                    'WM_SEC.ACCESS_TOKEN': accessToken,
                    'WM_SVC.NAME': 'Walmart Marketplace',
                    'WM_QOS.CORRELATION_ID': correlationId,
                    ...(environment === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : {}),
                    'Accept': 'application/json'
                }
            });

            logHttpResponse('Walmart get shipping template details request', response, correlationId);
            if (response.code < 200 || response.code >= 300) {
                throw new Error(`Walmart get shipping template details request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
            }
            return response;
        }

        function escapeHtml(value) {
            return String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
        }

        /**
         * Same regions[] shape Walmart returns from GET as this file itself builds in
         * buildTemplatePayload() (regions[].subRegions[].states[].stateSubregions[]), so this
         * walks it the same way describeConfigForError() does, but spells out full state names
         * for a human reading the lookup result rather than a short error message.
         */
        function describeRegionsForDisplay(regions) {
            return (regions || []).map((r) => {
                if (r.regionCode !== 'C') return escapeHtml(r.regionName || REGION_CODES[r.regionCode] || r.regionCode);
                if (!r.subRegions || !r.subRegions.length || getRegionLeaves(r).length >= ALL_C_LEAVES.length) {
                    return escapeHtml(`${r.regionName || REGION_CODES.C} (full coverage)`);
                }
                const stateNames = [];
                r.subRegions.forEach((sr) => (sr.states || []).forEach((s) => {
                    if (s.stateSubregions && s.stateSubregions.length) {
                        stateNames.push(`${s.stateName || s.stateCode} (${s.stateSubregions.map((ss) => ss.stateSubregionName || ss.stateSubregionCode).join(', ')})`);
                    } else {
                        stateNames.push(s.stateName || s.stateCode);
                    }
                }));
                return `48 State -- narrowed to ${stateNames.length} state(s): ${escapeHtml(stateNames.join(', '))}`;
            }).join(' + ');
        }

        /**
         * Tiered rows or per-shipment charge fields, whichever the configuration actually has.
         * Walmart's GET response sends tieredShippingCharges:[] (empty, still truthy) on
         * PER_SHIPMENT_PRICING configs too -- must check .length, not just presence, same gap
         * as describeRegionsForDisplay()'s subRegions check. perShippingCharge also doesn't
         * always include all three charge sub-fields (e.g. chargePerWeight can be entirely
         * absent on a config that only charges a per-item fee) -- default each to {amount:0}
         * rather than assuming all three are always present.
         */
        function describePricingForDisplay(config) {
            if (config.tieredShippingCharges && config.tieredShippingCharges.length) {
                return config.tieredShippingCharges.map((t) => {
                    const max = t.maxLimit === -1 ? 'unlimited' : t.maxLimit;
                    return escapeHtml(`$${t.shipCharge.amount} ${t.shipCharge.currency} for item price ${t.minLimit}-${max}`);
                }).join('<br>');
            }
            if (config.perShippingCharge) {
                const c = config.perShippingCharge;
                const handling = c.shippingAndHandling || { amount: 0, currency: 'USD' };
                const perWeight = c.chargePerWeight || { amount: 0 };
                const perItem = c.chargePerItem || { amount: 0 };
                return escapeHtml(`$${handling.amount} flat + $${perWeight.amount}/${c.unitOfMeasure || 'lb'} + $${perItem.amount}/item (${handling.currency})`);
            }
            return '(no pricing info)';
        }

        /** Template-level fields as a small table, then one heading + configuration list per shipping method. */
        function buildTemplateSummaryHtml(payload) {
            const rows = [
                ['Name', payload.name],
                ['Type', TEMPLATE_TYPES[payload.type] || payload.type],
                ['Rate Model', RATE_MODEL_TYPES[payload.rateModelType] || payload.rateModelType],
                ['Status', payload.status]
            ];
            if (payload.shippingType) rows.push(['Shipping Type', payload.shippingType]);
            if (payload.fulfillmentCenterIds && payload.fulfillmentCenterIds.length) rows.push(['Fulfillment Centers', payload.fulfillmentCenterIds.join(', ')]);

            let html = '<table style="border-collapse:collapse;margin-bottom:20px;">'
                + rows.map(([label, value]) => `<tr><td style="padding:3px 12px 3px 0;color:#666;font-size:13px;">${escapeHtml(label)}</td>`
                    + `<td style="padding:3px 0;font-weight:bold;">${escapeHtml(value)}</td></tr>`).join('')
                + '</table>';

            (payload.shippingMethods || []).forEach((m) => {
                html += `<h3 style="margin:20px 0 8px;padding-bottom:6px;border-bottom:2px solid #000;font-size:18px;">`
                    + `${escapeHtml(SHIP_METHODS[m.shipMethod] || m.shipMethod)} `
                    + `<span style="font-weight:normal;font-size:13px;color:#666;">(${escapeHtml(m.status)})</span></h3>`;
                (m.configurations || []).forEach((config, i) => {
                    html += `<div style="margin:0 0 10px;padding:8px 12px;background:#f7f7f7;border-radius:4px;font-size:13px;">`
                        + `<div><strong>Configuration ${i + 1}</strong></div>`
                        + `<div>Regions: ${describeRegionsForDisplay(config.regions)}</div>`
                        + `<div>Address Types: ${escapeHtml((config.addressTypes || []).join(', ') || '(none)')} `
                        + `&nbsp;|&nbsp; Transit Time: ${escapeHtml(config.transitTime)} day(s)</div>`
                        + `<div>Pricing: ${describePricingForDisplay(config)}</div>`
                        + '</div>';
                });
            });
            return html;
        }

        /** Human-readable summary when the response parses; falls back to the raw body (e.g. a non-JSON error page) otherwise. Raw JSON is always still available, tucked into a collapsible <details> block. */
        function buildLookupResultPage(params) {
            const { templateId, responseBody, errorMessage, correlationId } = params;
            const form = serverWidget.createForm({ title: errorMessage ? `Look Up Failed -- Template ${templateId}` : `Current Template ${templateId} (Read-Only)` });

            let parsed = null;
            if (!errorMessage) {
                try { parsed = JSON.parse(responseBody); } catch (e) { /* fall through to raw body below */ }
            }
            // GET by templateId wraps the single template in a top-level array, unwrap before reading any of its fields.
            const template = Array.isArray(parsed) ? parsed[0] : parsed;

            if (errorMessage || !template) {
                const resultField = form.addField({ id: 'custpage_lookup_result', type: serverWidget.FieldType.LONGTEXT, label: 'Result' });
                resultField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
                resultField.defaultValue = errorMessage
                    ? errorMessage + (correlationId ? `\n\ncorrelationId: ${correlationId}` : '')
                    : responseBody;
            } else {
                const summaryField = form.addField({ id: 'custpage_lookup_summary', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
                summaryField.defaultValue = buildTemplateSummaryHtml(template)
                    + '<details style="margin-top:16px;"><summary style="cursor:pointer;font-weight:bold;">Raw JSON</summary>'
                    + `<pre style="white-space:pre-wrap;font-size:12px;background:#f7f7f7;padding:10px;border-radius:4px;max-height:500px;overflow:auto;">${escapeHtml(JSON.stringify(parsed, null, 2))}</pre></details>`;
            }

            const nextField = form.addField({ id: 'custpage_lookup_next', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
            nextField.defaultValue = '<div style="padding:10px 0;">'
                + `<a href="${buildSuiteletUrl()}" style="${BUTTON_STYLE}margin-right:10px;">Look up another template</a>`
                + (errorMessage ? '' : `<a href="${buildSuiteletUrl()}&custpage_prefill_template_id=${encodeURIComponent(templateId)}" style="${BUTTON_STYLE}">Update this template</a>`)
                + '</div>';

            return form;
        }

        function submitShippingTemplateUpdate(params) {
            const { accessToken, baseUrl, correlationId, environment, templateId, payload } = params;

            const response = https.put({
                url: `${baseUrl}/v3/settings/shipping/templates/${encodeURIComponent(templateId)}`,
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

            logHttpResponse('Walmart update shipping template request', response, correlationId);
            if (response.code < 200 || response.code >= 300) {
                throw new Error(`Walmart update shipping template request failed (${response.code}, correlationId=${correlationId}): ${response.body}`);
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
            const { templateId, payload, status, responseBody, errorMessage, correlationId } = params;
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

                if (templateId) rec.setValue({ fieldId: RESULT_RECORD.FIELDS.TEMPLATE_ID, value: templateId });

                return rec.save({ enableSourcing: false, ignoreMandatoryFields: true });
            } catch (recordError) {
                log.error('Failed to write shipping template log record', {
                    name, errorMessage: recordError && recordError.message
                });
                return null;
            }
        }

        function buildResultPage(params) {
            const { success, message, correlationId, responseBody } = params;
            const form = serverWidget.createForm({ title: success ? 'Shipping Template Updated' : 'Shipping Template Update Failed' });
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
                + `<a href="${buildSuiteletUrl()}" style="${BUTTON_STYLE}">Update another template</a>`
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
