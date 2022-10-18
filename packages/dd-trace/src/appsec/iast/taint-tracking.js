const { storage } = require('../../../../datadog-core')
const iastContextFunctions = require('./iast-context')
const IAST_TRANSACTION_ID = Symbol('_dd.iast.transactionId')
const TaintedUtils = require('@datadog/native-iast-taint-tracking')
const { Rewriter } = require('@datadog/native-iast-rewriter')

const rewriter = new Rewriter();

const noop = function(res){return res}
const TaintTrackingDummy = {
    plusOperator: noop
}

const TaintTracking = {
    plusOperator: function(res, op1, op2){
        try {
            if (typeof res !== 'string' ||
                (typeof op1 !== 'string' && typeof op2 !== 'string')){ return res; }

            const store = storage.getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const transactionId = iastContext && iastContext[IAST_TRANSACTION_ID]
            if (transactionId){
                res = TaintedUtils.concat(transactionId, res, op1, op2)
            }
        }catch(e){
            // log exception?
        }
        return res
    }
};

const createTransaction = function(id, iastContext){
    const transactionId = TaintedUtils.createTransaction(id)
    iastContext[IAST_TRANSACTION_ID] = transactionId
}
const removeTransaction = function(iastContext){
    if (iastContext[IAST_TRANSACTION_ID]){
        const transactionId = iastContext[IAST_TRANSACTION_ID]
        TaintedUtils.removeTransaction(transactionId)
    }
}
const enableTaintTracking = function(enable){
    let success
    if (enable && TaintedUtils) {
        global._ddiast = global._ddiast || TaintTracking;
        success = true
    }
    else {
        global._ddiast = TaintTrackingDummy
        success = false
    }
    return success
}

module.exports = {
    createTransaction,
    removeTransaction,
    enableTaintTracking
}
