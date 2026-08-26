/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * QBO re-authorization helper for customscript_wal_order_import_mr (wm_mr_order_import.js).
 *
 * customscript_wal_order_import_mr (wm_mr_order_import.js) getQboAccessToken() 
 * reads QBO tokens from N/cache (name 'walQboCache', scope PROTECTED), falling back to the seeded
 * custscript_wal_qbo_refresh_seed script parameter only when the cache is
 * empty. NetSuite's N/cache is documented as best-effort -- values can be
 * evicted before their TTL -- which is what actually happened once already,
 * leaving that script stuck on a dead seed token with no way to recover on
 * its own.
 *
 * Two ways to (re)authorize here:
 *   1. One-click redirect: the "Connect to QBO" link sends the browser to
 *      Intuit's consent screen; approving it redirects back to THIS
 *      Suitelet's own URL (custscript_wal_qbo_auth_redirect_uri, which must
 *      be registered exactly as-is in this QBO app's Keys & OAuth settings)
 *      with an authorization code, which onRequest()/handleCallback()
 *      exchanges automatically. Requires being logged into NetSuite in the
 *      same browser tab the whole round trip -- the deployment is
 *      deliberately NOT "available without login", since a real external
 *      caller (no NetSuite session at all) is never involved here, only a
 *      redirect-and-back of the same authenticated browser.
 *   2. Paste-in fallback: generate a refresh token via Intuit's OAuth2
 *      Playground (https://developer.intuit.com/v2/OAuth2Playground/) and
 *      paste it into the form instead -- useful if the redirect URI isn't
 *      registered yet, or the one-click flow ever breaks.
 * 
 * Both paths exchange immediately (so a bad code/token fails right here,
 * not on the next Sales Order import) and write into the SAME cache
 * wm_mr_order_import.js reads, so no script parameter edit or redeploy is
 * needed afterward.
 *
 * Script parameters:
 *   custscript_wal_qbo_auth_client_id     - QBO app Client ID (same app wm_mr_order_import.js uses)
 *   custscript_wal_qbo_auth_client_secret - QBO app Client Secret (Password field type)
 *   custscript_wal_qbo_auth_env           - "PRODUCTION" or "SANDBOX" (defaults to SANDBOX)
 *   custscript_wal_qbo_auth_redirect_uri  - This Suitelet's own URL (e.g.
 *                                            https://<account>.app.netsuite.com/app/site/hosting/scriptlet.nl?script=...&deploy=...),
 *                                            registered exactly as-is in Intuit's Keys & OAuth
 *                                            settings for this app. A script parameter (not
 *                                            hardcoded) since sandbox and production accounts
 *                                            each have their own URL. Omit this param entirely
 *                                            to hide the one-click link and fall back to
 *                                            paste-in only.
 */
define(
    ['N/https', 'N/encode', 'N/cache', 'N/runtime', 'N/log', 'N/ui/serverWidget', 'N/crypto/random'],
    (https, encode, cache, runtime, log, serverWidget, random) => {

        const QBO_TOKEN_ENDPOINT = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
        const QBO_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
        const QBO_SCOPE = 'com.intuit.quickbooks.accounting';
        // Same cache name/scope/keys customscript_wal_order_import_mr (wm_mr_order_import.js) 
        // getQboAccessToken() reads.
        const QBO_CACHE_NAME = 'walQboCache';
        const QBO_CACHE_KEYS = { ACCESS_TOKEN: 'accessToken', REFRESH_TOKEN: 'refreshToken' };
        const QBO_TTL_SAFETY_MARGIN_SECONDS = 60;

        const PARAMS = {
            CLIENT_ID: 'custscript_wal_qbo_auth_client_id',
            CLIENT_SECRET: 'custscript_wal_qbo_auth_client_secret',
            ENVIRONMENT: 'custscript_wal_qbo_auth_env',
            REDIRECT_URI: 'custscript_wal_qbo_auth_redirect_uri'
        };

        const REFRESH_TOKEN_FIELD = 'custpage_refresh_token';
        const PLAYGROUND_URL = 'https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0-playground';

        // Separate cache from the QBO tokens themselves -- holds the one-time CSRF state
        // value between building the "Connect" link and Intuit's callback. Short TTL is
        // plenty for a human to click through Intuit's consent screen.
        const STATE_CACHE_NAME = 'walQboAuthState';
        const STATE_CACHE_KEY = 'oauthState';
        const STATE_TTL_SECONDS = 600;

        function onRequest(context) {
            const params = context.request.parameters;

            // Intuit's callback is a GET carrying either ?code=...&state=...&realmId=...
            // (approved) or ?error=...&state=... (denied) -- either way it's the redirect
            // flow's return leg, not the initial form load.
            if (context.request.method === 'GET' && (params.code || params.error)) {
                handleCallback(context);
                return;
            }

            if (context.request.method === 'GET') {
                context.response.writePage(buildForm(null, getScriptParams()));
                return;
            }

            handleSubmit(context);
        }

        function buildForm(message, ctx) {
            const form = serverWidget.createForm({ title: `QBO Re-Authorization (Walmart Order Import) - ${ctx.qboEnvironment}` });

            if (message) {
                const messageField = form.addField({
                    id: 'custpage_message',
                    type: serverWidget.FieldType.INLINEHTML,
                    label: 'Message'
                });
                messageField.defaultValue = `<div style="padding:10px 0;font-weight:bold;">${escapeHtml(message)}</div>`;
            }

            const buttonStyle = 'display:inline-block;padding:10px 20px;background:#187bf2;color:#fff;'
                + 'font-weight:bold;font-size:14px;text-decoration:none;border-radius:3px;border:none;cursor:pointer;';

            if (ctx.qboClientId && ctx.qboRedirectUri) {
                const connectField = form.addField({
                    id: 'custpage_connect',
                    type: serverWidget.FieldType.INLINEHTML,
                    label: 'Connect'
                });
                connectField.defaultValue = '<div style="padding:10px 0;">'
                    + `<a href="${escapeHtml(buildAuthorizeUrl(ctx))}" style="${buttonStyle}">Connect to QBO</a>`
                    + '</div>';
            }

            const instructionsField = form.addField({
                id: 'custpage_instructions',
                type: serverWidget.FieldType.INLINEHTML,
                label: 'Instructions'
            });
            const orPrefix = (ctx.qboClientId && ctx.qboRedirectUri)
                ? '<p>-- or, if the button above doesn\'t work --</p>'
                : '';
            instructionsField.defaultValue = orPrefix
                + '<p>Generate a refresh token via '
                + `<a href="${PLAYGROUND_URL}" target="_blank">Intuit's OAuth2 Playground</a>, `
                + 'then paste it in the text box, then click Authorize. It will be exchanged immediately to confirm it works.</p>';

            form.addField({
                id: REFRESH_TOKEN_FIELD,
                type: serverWidget.FieldType.TEXTAREA,
                label: 'Refresh Token'
            });

            // form.addSubmitButton() always renders in NetSuite's fixed button bar at the
            // TOP of the page, no matter where it's called from -- there's no API to move it.
            // Rendering our own <button type="submit"> via INLINEHTML instead keeps it inside
            // the same <form> NetSuite generates (so it submits identically) while letting us
            // place it right after the paste-in box, where it visually belongs.
            const submitField = form.addField({
                id: 'custpage_submit',
                type: serverWidget.FieldType.INLINEHTML,
                label: 'Submit'
            });
            submitField.defaultValue = `<div style="padding:10px 0;"><button type="submit" style="${buttonStyle}">Authorize</button></div>`;

            return form;
        }

        /** Builds Intuit's authorize URL and stashes a fresh one-time CSRF state value for handleCallback() to check. */
        function buildAuthorizeUrl(ctx) {
            const state = random.generateUUID();
            const stateCache = cache.getCache({ name: STATE_CACHE_NAME, scope: cache.Scope.PRIVATE });
            stateCache.put({ key: STATE_CACHE_KEY, value: state, ttl: STATE_TTL_SECONDS });

            const queryParams = {
                client_id: ctx.qboClientId,
                response_type: 'code',
                scope: QBO_SCOPE,
                redirect_uri: ctx.qboRedirectUri,
                state
            };
            const queryString = Object.keys(queryParams)
                .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(queryParams[key])}`)
                .join('&');
            return `${QBO_AUTHORIZE_URL}?${queryString}`;
        }

        // Only ever interpolated into buildForm()'s status message, which can echo back
        // whatever QBO's error response body contains -- escape it rather than trust it.
        function escapeHtml(value) {
            return String(value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        }

        function getScriptParams() {
            const script = runtime.getCurrentScript();
            return {
                qboClientId: script.getParameter({ name: PARAMS.CLIENT_ID }),
                qboClientSecret: script.getParameter({ name: PARAMS.CLIENT_SECRET }),
                qboEnvironment: (script.getParameter({ name: PARAMS.ENVIRONMENT }) || 'SANDBOX').toUpperCase(),
                qboRedirectUri: script.getParameter({ name: PARAMS.REDIRECT_URI })
            };
        }

        /** Exchanges a token endpoint response into the cache wm_mr_order_import.js reads; returns the access-token TTL actually used. */
        function storeTokens(parsed) {
            const qboCache = cache.getCache({ name: QBO_CACHE_NAME, scope: cache.Scope.PROTECTED });

            let accessTtl = parsed.expires_in;
            if (accessTtl > QBO_TTL_SAFETY_MARGIN_SECONDS) accessTtl -= QBO_TTL_SAFETY_MARGIN_SECONDS;
            qboCache.put({ key: QBO_CACHE_KEYS.ACCESS_TOKEN, value: parsed.access_token, ttl: accessTtl });

            // QBO rotates the refresh token on every use -- store the NEW one it just
            // returned, never the one that was pasted/exchanged in (that one is now stale).
            if (parsed.refresh_token && parsed.x_refresh_token_expires_in) {
                qboCache.put({ key: QBO_CACHE_KEYS.REFRESH_TOKEN, value: parsed.refresh_token, ttl: parsed.x_refresh_token_expires_in });
            }
            return accessTtl;
        }

        function successMessage(parsed, accessTtl) {
            return `Access token cached for ~${Math.round(accessTtl / 60)} minutes, `
                + `refresh token cached for ~${Math.round((parsed.x_refresh_token_expires_in || 0) / 86400)} days. `
                + 'wm_mr_order_import.js will pick these up on its next run.';
        }

        /**
         * Handles Intuit's redirect back from the consent screen. State is checked
         * (and immediately consumed -- one-time use) before anything else, since it's
         * the only thing proving this callback corresponds to a "Connect" link this
         * same Suitelet actually generated rather than a forged/replayed request.
         */
        function handleCallback(context) {
            const ctx = getScriptParams();
            const params = context.request.parameters;

            const stateCache = cache.getCache({ name: STATE_CACHE_NAME, scope: cache.Scope.PRIVATE });
            const expectedState = stateCache.get({ key: STATE_CACHE_KEY });
            if (!expectedState || params.state !== expectedState) {
                context.response.writePage(buildForm(
                    'OAuth state mismatch -- the Connect link may have expired (10 min) or already been used. Click Connect to QBO again.',
                    ctx
                ));
                return;
            }
            stateCache.remove({ key: STATE_CACHE_KEY });

            if (params.error) {
                context.response.writePage(buildForm(
                    `QBO authorization was not granted: ${params.error}${params.error_description ? ' -- ' + params.error_description : ''}`,
                    ctx
                ));
                return;
            }

            if (!ctx.qboClientId || !ctx.qboClientSecret) {
                context.response.writePage(buildForm(
                    'custscript_wal_qbo_auth_client_id / custscript_wal_qbo_auth_client_secret are not set on this deployment.',
                    ctx
                ));
                return;
            }

            try {
                const basicAuth = encode.convert({
                    string: `${ctx.qboClientId}:${ctx.qboClientSecret}`,
                    inputEncoding: encode.Encoding.UTF_8,
                    outputEncoding: encode.Encoding.BASE_64
                });

                const response = https.post({
                    url: QBO_TOKEN_ENDPOINT,
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Authorization': `Basic ${basicAuth}`
                    },
                    body: { grant_type: 'authorization_code', code: params.code, redirect_uri: ctx.qboRedirectUri }
                });

                if (response.code !== 200) {
                    log.error('QBO auth - code exchange failed', { code: response.code, body: response.body });
                    context.response.writePage(buildForm(`QBO rejected the authorization code (${response.code}): ${response.body}`, ctx));
                    return;
                }

                const parsed = JSON.parse(response.body);
                const accessTtl = storeTokens(parsed);

                log.audit('QBO auth - connected via one-click redirect', { environment: ctx.qboEnvironment, realmId: params.realmId });
                context.response.writePage(buildForm(
                    `Success (QBO company/realmId: ${params.realmId} -- confirm this matches custscript_wal_qbo_company_id). `
                    + successMessage(parsed, accessTtl),
                    ctx
                ));
            } catch (e) {
                log.error('QBO auth - unexpected error during callback', { errorName: e && e.name, errorMessage: e && e.message });
                context.response.writePage(buildForm(`Unexpected error: ${e.message}`, ctx));
            }
        }

        function handleSubmit(context) {
            const ctx = getScriptParams();
            const refreshToken = (context.request.parameters[REFRESH_TOKEN_FIELD] || '').trim();
            if (!refreshToken) {
                context.response.writePage(buildForm('Paste a refresh token before submitting.', ctx));
                return;
            }

            if (!ctx.qboClientId || !ctx.qboClientSecret) {
                context.response.writePage(buildForm(
                    'custscript_wal_qbo_auth_client_id / custscript_wal_qbo_auth_client_secret are not set on this deployment.',
                    ctx
                ));
                return;
            }

            try {
                const basicAuth = encode.convert({
                    string: `${ctx.qboClientId}:${ctx.qboClientSecret}`,
                    inputEncoding: encode.Encoding.UTF_8,
                    outputEncoding: encode.Encoding.BASE_64
                });

                const response = https.post({
                    url: QBO_TOKEN_ENDPOINT,
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Authorization': `Basic ${basicAuth}`
                    },
                    body: { grant_type: 'refresh_token', refresh_token: refreshToken }
                });

                if (response.code !== 200) {
                    log.error('QBO auth - exchange failed', { code: response.code, body: response.body });
                    context.response.writePage(buildForm(`QBO rejected that token (${response.code}): ${response.body}`, ctx));
                    return;
                }

                const parsed = JSON.parse(response.body);
                const accessTtl = storeTokens(parsed);

                log.audit('QBO auth - manually re-authorized (paste-in)', { environment: ctx.qboEnvironment });
                context.response.writePage(buildForm(`Success. ${successMessage(parsed, accessTtl)}`, ctx));
            } catch (e) {
                log.error('QBO auth - unexpected error', { errorName: e && e.name, errorMessage: e && e.message });
                context.response.writePage(buildForm(`Unexpected error: ${e.message}`, ctx));
            }
        }

        return { onRequest };
    }
);
