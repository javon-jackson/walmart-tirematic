/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * Shared Walmart webhook receiver. Sits behind a Zoho Flow relay that
 * overrides the User-Agent header from the Walmart webhook.
 *
 * Looks up the incoming event's eventType in ROUTES, extracts one or more
 * ids from the payload, and passes each id to the matching Map/Reduce script
 * via N/task. Further data processing lives in the Map/Reduce scripts
 * themselves -- this file only routes.
 *
 * Dispatches across each route's own pool of deployment IDs (a busy
 * rotation deployment for one route doesn't affect another route's calls).
 *
 * Always responds 200 regardless of dispatch outcome. A dispatch failure
 * (all rotation deployments busy, bad payload, etc.) is only logged here --
 * each Map/Reduce script's own hourly reconciliation run is what actually
 * guarantees the item eventually gets processed, not a webhook retry.
 *
 * NetSuite deployment setup needed for this Suitelet:
 *   - Available without Login: checked
 *   - External Roles: Online Form User
 *   - Execute As Role: Administrator
 *   - Log Level: Debug
 *   - Status: Released
 * Then point the Zoho Flow relay's Send Webhook action at this Suitelet's
 * external URL. (Walmart Webhook to NetSuite Relay)
 *
 * "Execute As Role: Administrator" is required -- without it, the anonymous
 * caller only has Online Form User's restricted guest permissions, which
 * cannot submit an N/task Map/Reduce task ("You do not have permission to
 * perform this operation.").
 */
define(['N/task', 'N/log', 'N/email'], (task, log, email) => {

    // Set on the dispatched task's params whenever a route's sendDeliveredEmailAlert
    // fires here, so wm_mr_return_import.js's reduce() knows not to send a
    // duplicate -- must match PARAMS.ALERT_ALREADY_SENT there exactly.
    const ALERT_ALREADY_SENT_PARAM = 'custscript_wal_retimp_sent_deliver_alert';

    const RETURN_ALERT_AUTHOR = 126970; // TODO: same placeholder as wm_mr_return_import.js -- set to a real NetSuite employee internal id
    const RETURN_ALERT_RECIPIENTS = [
        // 12493, // Nick
        // 82292, // Moka Kash
        // 28068, // Camilo Espinosa
        // 13     // Ricky Chavez
        126970 // Me
    ];

    /**
     * Fast path for RETURN_DELIVERED -- sends the "needs inspection" alert
     * immediately off the webhook payload alone (no Walmart API call needed),
     * instead of waiting on the dispatched Map/Reduce task to detect the same
     * transition via its before/after diff. That diff logic still runs as the
     * safety net for a missed/delayed webhook -- see ALERT_ALREADY_SENT_PARAM.
     */
    function sendReturnDeliveredAlertEmail(returnOrderId) {
        try {
            email.send({
                author: RETURN_ALERT_AUTHOR,
                recipients: RETURN_ALERT_RECIPIENTS,
                subject: `Walmart Return ${returnOrderId} - Delivered, Needs Inspection`,
                body: '<html><body>'
                    + `<p>Return <strong>${returnOrderId}</strong> has arrived at the return center.</p>`
                    + '<p>Someone needs to physically inspect it (unmounted, unused, within the return window) '
                    + 'and record the outcome in the return review tool before it can be approved/rejected.</p>'
                    + '</body></html>'
            });
            log.audit({ title: 'Webhook - return-delivered alert email sent', details: JSON.stringify({ returnOrderId }) });
        } catch (emailError) {
            log.error({
                title: 'Webhook - failed to send return-delivered alert email',
                details: JSON.stringify({ returnOrderId, errorMessage: emailError && emailError.message })
            });
        }
    }

    /**
     * extractIds(event) returns a string array of ids to dispatch (0, 1, or
     * many). Returning multiple ids submits one Map/Reduce task per id --
     * e.g. one RETURN_CREATED event can carry several returnOrders lines.
     */
    const ROUTES = {
        // https://developer.walmart.com/us-marketplace/docs/purchase-order-po-created-event
        PO_CREATED: {
            scriptId: 'customscript_wal_order_import_mr', 
            deploymentIds: ['customdeploy_wal_pocreated_handler_1_sb'],
            idParameter: 'custscript_wal_order_import_po_id',
            extractIds: (event) => {
                const purchaseOrderId = event && event.payload && event.payload.purchaseOrderId;
                return purchaseOrderId ? [String(purchaseOrderId)] : [];
            }
        },
        // https://developer.walmart.com/us-marketplace/docs/return-notifications
        RETURN_CREATED: {
            scriptId: 'customscript_wal_return_order_import_mr',
            deploymentIds: ['customdeploy_sandbox_1'],
            idParameter: 'custscript_wal_return_import_retorder_id',
            extractIds: extractReturnOrderIds
        },
        RETURN_DELIVERED: {
            scriptId: 'customscript_wal_return_order_import_mr',
            deploymentIds: ['customdeploy_sandbox_1'],
            idParameter: 'custscript_wal_return_import_retorder_id',
            extractIds: extractReturnOrderIds,
            sendDeliveredEmailAlert: true
        },
        RETURN_INVOICED: {
            scriptId: 'customscript_wal_return_order_import_mr',
            deploymentIds: ['customdeploy_sandbox_1'],
            idParameter: 'custscript_wal_return_import_retorder_id',
            extractIds: extractReturnOrderIds
        }
    };

    function extractReturnOrderIds(event) {
        const returnOrders = event && event.payload && event.payload.returnOrders;
        if (!Array.isArray(returnOrders)) return [];
        return returnOrders
            .map((line) => line && line.returnOrderId)
            .filter(Boolean)
            .map(String);
    }

    const onRequest = (context) => {
        const request = context.request;

        context.response.setHeader({ name: 'Content-Type', value: 'application/json' });

        if (request.method !== 'POST') {
            log.audit({ title: 'Webhook - non-POST hit', details: request.method });
            context.response.write(JSON.stringify({ received: true }));
            return;
        }

        let event;
        try {
            event = JSON.parse(request.body);
        } catch (e) {
            log.error({ title: 'Webhook - failed to parse body', details: request.body });
            context.response.write(JSON.stringify({ received: true }));
            return;
        }

        const eventType = event && event.source && event.source.eventType;
        const eventId = event && event.source && event.source.eventId;
        const route = ROUTES[eventType];

        if (!route) {
            log.audit({
                title: 'Webhook - ignored, event type not routed',
                details: JSON.stringify({ eventType, eventId })
            });
            context.response.write(JSON.stringify({ received: true }));
            return;
        }

        const ids = route.extractIds(event);

        log.audit({
            title: 'Webhook - event received',
            details: JSON.stringify({ eventType, eventId, ids })
        });

        if (ids.length === 0) {
            log.error({
                title: 'Webhook - routed event missing expected id(s)',
                details: JSON.stringify({ eventType, eventId, event })
            });
            context.response.write(JSON.stringify({ received: true }));
            return;
        }

        ids.forEach((id) => {
            if (route.sendDeliveredEmailAlert) sendReturnDeliveredAlertEmail(id);
            submitTaskIfEligible({ route, eventType, id });
        });
        context.response.write(JSON.stringify({ received: true }));
    };

    function submitTaskIfEligible(params) {
        const { route, eventType, id } = params;
        let lastTaskError = null;

        for (let i = 0; i < route.deploymentIds.length; i++) {
            const deploymentId = route.deploymentIds[i];

            try {
                const taskParams = {};
                taskParams[route.idParameter] = id;
                if (route.sendDeliveredEmailAlert) taskParams[ALERT_ALREADY_SENT_PARAM] = 'T';

                const taskId = task.create({
                    taskType: task.TaskType.MAP_REDUCE,
                    scriptId: route.scriptId,
                    deploymentId,
                    params: taskParams
                }).submit();

                log.audit({
                    title: 'Webhook - Map/Reduce task submitted',
                    details: JSON.stringify({ eventType, taskId, id, deploymentId, scriptId: route.scriptId })
                });
                return;
            } catch (taskError) {
                lastTaskError = taskError;
                log.debug({
                    title: 'Webhook - deployment unavailable, trying next',
                    details: JSON.stringify({ eventType, id, deploymentId, errorMessage: taskError && taskError.message })
                });
            }
        }

        log.error({
            title: 'Webhook - task not submitted, all rotation deployments busy',
            details: JSON.stringify({
                eventType,
                id,
                scriptId: route.scriptId,
                attemptedDeploymentIds: route.deploymentIds,
                errorMessage: lastTaskError && lastTaskError.message
            })
        });
    }

    return { onRequest };
});
