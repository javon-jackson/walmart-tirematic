#!/usr/bin/env node
/**
 * Pulls the current Walmart Marketplace item spec (JSON Schema) for one or
 * more product types directly from Walmart's API, so you can diff it
 * against whatever spec file you're currently trusting (e.g. Tires.json)
 * instead of relying on a possibly-stale export.
 *
 * Endpoint: POST /v3/items/spec
 * Docs: https://developer.walmart.com/us-marketplace/reference/getspec
 *
 *
 * Usage:
 *   1. Create .env (in the project root) with WALMART_CLIENT_ID /
 *      WALMART_CLIENT_SECRET (or the env-specific
 *      WALMART_SANDBOX_CLIENT_ID/SECRET and
 *      WALMART_PRODUCTION_CLIENT_ID/SECRET if you need both at once --
 *      the script picks whichever pair matches --env). .env is gitignored
 *      and is only ever read locally by this script -- never printed or
 *      sent anywhere but directly to Walmart's own token/spec endpoints.
 *   2. node scripts/fetch-walmart-item-spec.js Tires
 *
 *   node scripts/fetch-walmart-item-spec.js Tires "Automotive Parts" --env=PRODUCTION --version=5.0.20260608-18_15_07-api
 *
 * Env vars (settable via .env or the real shell environment; real env vars
 * win if both are set):
 *   WALMART_SANDBOX_CLIENT_ID       required for --env=SANDBOX (falls back
 *                                   to WALMART_CLIENT_ID if unset)
 *   WALMART_SANDBOX_CLIENT_SECRET   required for --env=SANDBOX (falls back
 *                                   to WALMART_CLIENT_SECRET if unset)
 *   WALMART_PRODUCTION_CLIENT_ID       required for --env=PRODUCTION (falls
 *                                      back to WALMART_CLIENT_ID if unset)
 *   WALMART_PRODUCTION_CLIENT_SECRET   required for --env=PRODUCTION (falls
 *                                      back to WALMART_CLIENT_SECRET if unset)
 *   WALMART_CLIENT_ID       fallback used when no per-env id is set
 *   WALMART_CLIENT_SECRET   fallback used when no per-env secret is set
 *   WALMART_ENV             SANDBOX (default) | PRODUCTION
 *   WALMART_FEED_TYPE       default: MP_ITEM
 *   WALMART_SPEC_VERSION    default (production): "5.0.20260608-18_15_07-api"
 *                           -- confirmed working as of 2026-07-30. Walmart
 *                           bumps this periodically; if a request starts
 *                           getting rejected as an invalid version, check
 *                           Seller Center or developer.walmart.com's
 *                           "What's new" page for the current string and
 *                           pass it via --version= or this env var.
 *
 * Output: writes the returned schema to ./walmart-spec-output/<productType>.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE_URLS = {
    PRODUCTION: 'https://marketplace.walmartapis.com',
    SANDBOX: 'https://sandbox.walmartapis.com'
};

/**
 * Minimal .env loader -- no dependency on the `dotenv` package. Real
 * environment variables always take precedence over what's in the file.
 */
function loadDotEnv(filePath) {
    if (!fs.existsSync(filePath)) return;
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
    }
}

function parseArgs(argv) {
    const productTypes = [];
    const flags = {};
    for (const arg of argv) {
        if (arg.startsWith('--')) {
            const [key, value] = arg.slice(2).split('=');
            flags[key] = value === undefined ? true : value;
        } else {
            productTypes.push(arg);
        }
    }
    return { productTypes, flags };
}

async function getAccessToken({ clientId, clientSecret, baseUrl, correlationId, sandboxHeaders }) {
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const response = await fetch(`${baseUrl}/v3/token`, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${basicAuth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'WM_QOS.CORRELATION_ID': correlationId,
            'WM_SVC.NAME': 'Walmart Marketplace',
            ...sandboxHeaders
        },
        body: 'grant_type=client_credentials'
    });

    const body = await response.text();
    if (!response.ok) {
        throw new Error(`Token request failed (${response.status}): ${body}`);
    }

    const parsed = JSON.parse(body);
    if (!parsed.access_token) {
        throw new Error(`Token response missing access_token: ${body}`);
    }
    return parsed.access_token;
}

async function getItemSpec({ accessToken, baseUrl, feedType, version, productTypes, correlationId, sandboxHeaders }) {
    const response = await fetch(`${baseUrl}/v3/items/spec`, {
        method: 'POST',
        headers: {
            'WM_SEC.ACCESS_TOKEN': accessToken,
            'WM_QOS.CORRELATION_ID': correlationId,
            'WM_SVC.NAME': 'Walmart Marketplace',
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            ...sandboxHeaders
        },
        body: JSON.stringify({ feedType, version, productTypes })
    });

    const body = await response.text();
    if (!response.ok) {
        throw new Error(`Get Spec request failed (${response.status}): ${body}`);
    }
    return JSON.parse(body);
}

async function main() {
    loadDotEnv(path.join(__dirname, '..', '.env'));

    const { productTypes, flags } = parseArgs(process.argv.slice(2));
    console.log(productTypes);

    if (!productTypes.length) {
        console.error('Usage: node fetch-walmart-item-spec.js <ProductType> [<ProductType2> ...] [--env=SANDBOX|PRODUCTION] [--version=5.0]');
        process.exit(1);
    }
    if (productTypes.length > 20) {
        console.error('Walmart allows a maximum of 20 productTypes per request.');
        process.exit(1);
    }

    const environment = flags.env || process.env.WALMART_ENV || 'SANDBOX';
    const envUpper = environment.toUpperCase();
    const baseUrl = BASE_URLS[envUpper];
    if (!baseUrl) {
        console.error(`Unknown --env value "${environment}". Use SANDBOX or PRODUCTION.`);
        process.exit(1);
    }

    const clientId = process.env[`WALMART_${envUpper}_CLIENT_ID`] || process.env.WALMART_CLIENT_ID;
    const clientSecret = process.env[`WALMART_${envUpper}_CLIENT_SECRET`] || process.env.WALMART_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        console.error(`Set WALMART_${envUpper}_CLIENT_ID and WALMART_${envUpper}_CLIENT_SECRET (or the generic WALMART_CLIENT_ID / WALMART_CLIENT_SECRET) first.`);
        process.exit(1);
    }

    // TODO: Cannot get spec from sandbox! use prod access token and hit prod api.
    // Dynamic sandbox requires this header or requests fall back to the
    // static sandbox.
    const sandboxHeaders = envUpper === 'SANDBOX' ? { 'WM_SANDBOX': 'v2' } : undefined;

    // Sandbox docs reference Item Specification version 3 support; default
    // to that in sandbox. Production default is the last version confirmed
    // working (see WALMART_SPEC_VERSION doc above) -- override via
    // --version= if Walmart has since bumped it.
    const defaultVersion = '5.0.20260608-18_15_07-api';
    const feedType = flags.feedType || process.env.WALMART_FEED_TYPE || 'MP_ITEM';
    const version = flags.version || process.env.WALMART_SPEC_VERSION || defaultVersion;
    const correlationId = crypto.randomUUID();

    console.log(`Requesting ${feedType} v${version} spec for [${productTypes.join(', ')}] from ${baseUrl} ...`);

    const accessToken = await getAccessToken({ clientId, clientSecret, baseUrl, correlationId, sandboxHeaders });
    const spec = await getItemSpec({ accessToken, baseUrl, feedType, version, productTypes, correlationId, sandboxHeaders });

    const outDir = path.join(__dirname, '..', 'walmart-spec-output');
    fs.mkdirSync(outDir, { recursive: true });

    // Always write the raw response so nothing is lost if the per-type
    // extraction below is ever wrong for a future spec version; inspect
    // walmart-spec-output/_raw.json if the per-productType files look
    // empty or off.
    const rawPath = path.join(outDir, '_raw.json');
    fs.writeFileSync(rawPath, JSON.stringify(spec, null, 2));
    console.log(`Wrote raw response to ${rawPath}`);

    // Confirmed shape (v5.0.20250121-19_24_23-api): the response root has a
    // "schema" wrapper whose properties are MPItemFeedHeader and MPItem.
    // MPItem is a type:"array" schema, so its object fields live under
    // .items.properties -- which splits into Orderable (generic, same
    // fields for every product type) and Visible, nesting the type-specific
    // attributes one level deeper under each product type's own name.
    const visibleByType = spec?.schema?.properties?.MPItem?.items?.properties?.Visible?.properties;

    for (const productType of productTypes) {
        const outPath = path.join(outDir, `${productType.replace(/\s+/g, '_')}.json`);
        const productSchema = visibleByType?.[productType];
        if (!productSchema) {
            console.log(`Could not isolate a schema for "${productType}" in the response -- check ${rawPath}`);
            continue;
        }
        fs.writeFileSync(outPath, JSON.stringify(productSchema, null, 2));
        console.log(`Wrote ${outPath}`);
    }
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
