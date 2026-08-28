/**
*@NApiVersion 2.1
*@NScriptType UserEventScript
*/

define(['N/record', 'N/log', 'N/search'], (record, log, search) => {

    const QUEUE_RECORD = {
        TYPE: 'customrecord_wal_item_fulfillment_queue',
        FIELDS: {
            ITEM_FULFILLMENT: 'custrecord_wal_ffq_item_fulfillment',
            SALES_ORDER: 'custrecord_wal_ffq_sales_order',
            PURCHASE_ORDER_ID: 'custrecord_wal_ffq_po_id',
            STATUS: 'custrecord_wal_ffq_status',
            ERROR: 'custrecord_wal_ffq_error',
            PROCESSED_DATE: 'custrecord_wal_ffq_processed_date'
        }
    };

    function afterSubmit(context) {
        try {
            if (context.type === context.UserEventType.CREATE || 
                context.type === context.UserEventType.EDIT || 
                context.type === context.UserEventType.XEDIT) {
                const recordType = context.newRecord.type;
                const fulfillmentRecordId = context.newRecord.id;

                if (recordType === record.Type.ITEM_FULFILLMENT) {
                    const status = context.newRecord.getValue({ fieldId: 'shipstatus' });
                    if (status !== 'C') {
                        return;
                    }
                    const salesOrderId = context.newRecord.getValue({ fieldId: 'createdfrom'});
                    const salesOrderFields = search.lookupFields({ 
                        type: record.Type.SALES_ORDER,
                        id: salesOrderId,
                        columns: ['custbody_walmart_order', 'otherrefnum']
                    });
                    const purchaseOrderId = salesOrderFields.otherrefnum;
                    const isWalmartOrder = salesOrderFields.custbody_walmart_order === true;

                    if (!isWalmartOrder) {
                        return;
                    }

                    log.audit('Walmart item fulfillment detected', {
                        fulfillmentRecordId,
                        salesOrderId,
                        purchaseOrderNumber: purchaseOrderId
                    });

                    const queueRecordId = createQueueRecord(fulfillmentRecordId, salesOrderId, purchaseOrderId);
                    log.audit('Item fulfillment queue record created', queueRecordId);
                }
            }
        } catch (error) {
            log.error('Failed to write to Walmart item fulfillment queue.', { errorName: error && error.name, errorMessage: error && error.message });
        }
    }

    function createQueueRecord(fulfillmentRecordId, salesOrderId, purchaseOrderNumber) {
        const externalId = `wal-ffq-${fulfillmentRecordId}`;
        const existingId = findQueueRecordByExternalId(externalId);

        if (existingId) {
            log.audit('Queue record already exists.', {fulfillmentRecordId, queueRecordId: existingId});
            return existingId;
        }
        
        let queueRecord = record.create({
           type: QUEUE_RECORD.TYPE
        });

        queueRecord.setValue({
            fieldId: QUEUE_RECORD.FIELDS.ITEM_FULFILLMENT,
            value: fulfillmentRecordId
        });

        queueRecord.setValue({
            fieldId: QUEUE_RECORD.FIELDS.SALES_ORDER,
            value: salesOrderId
        });

        queueRecord.setValue({
            fieldId: QUEUE_RECORD.FIELDS.PURCHASE_ORDER_ID,
            value: purchaseOrderNumber
        });

        queueRecord.setValue({
            fieldId: QUEUE_RECORD.FIELDS.STATUS,
            value: 'Pending'
        });

        queueRecord.setValue({
            fieldId: 'externalid',
            value: externalId
        });


        const queueRecordId = queueRecord.save({
            enableSourcing: false,
            ignoreMandatoryFields: true
        });

        return queueRecordId;
    }

    function findQueueRecordByExternalId(externalId) {
        const queueSearch = search.create({
            type: QUEUE_RECORD.TYPE,
            filters: [['externalidstring', 'is', externalId]],
            columns: [search.createColumn({ name: 'internalid' })]
        });
        const results = queueSearch.run().getRange({ start: 0, end: 1}) || [];
        return results.length > 0 ? results[0].getValue({ name: 'internalid'}) : null;
    }

    return {
        afterSubmit
    }
});