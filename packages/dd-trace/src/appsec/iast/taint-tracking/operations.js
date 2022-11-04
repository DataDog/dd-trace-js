const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../iast-context')
const log = require('../../../log')
const TaintedUtils = require('@datadog/native-iast-taint-tracking')

const IAST_TRANSACTION_ID = Symbol('_dd.iast.transactionId')

function noop (res) { return res }
const TaintTrackingDummy = {
  plusOperator: noop
}

const TaintTracking = {
  plusOperator: function (res, op1, op2) {
    try {
      if (typeof res !== 'string' ||
        (typeof op1 !== 'string' && typeof op2 !== 'string')) { return res }

      const store = storage.getStore()
      const iastContext = iastContextFunctions.getIastContext(store)
      const transactionId = iastContext && iastContext[IAST_TRANSACTION_ID]
      if (transactionId) {
        res = TaintedUtils.concat(transactionId, res, op1, op2)
      }
    } catch (e) {
      log.debug(e)
    }
    return res
  }
}

class TaintOperations {
  createTransaction (id, iastContext) {
    if (id && iastContext) {
      iastContext[IAST_TRANSACTION_ID] = TaintedUtils.createTransaction(id)
    }
  }

  removeTransaction (iastContext) {
    if (iastContext && iastContext[IAST_TRANSACTION_ID]) {
      const transactionId = iastContext[IAST_TRANSACTION_ID]
      TaintedUtils.removeTransaction(transactionId)
    }
  }

  newTaintedString (iastContext, string, name, type) {
    if (iastContext && iastContext[IAST_TRANSACTION_ID]) {
      const transactionId = iastContext[IAST_TRANSACTION_ID]
      return TaintedUtils.newTaintedString(transactionId, string, name, type)
    }
  }

  isTainted (iastContext, string) {
    if (iastContext && iastContext[IAST_TRANSACTION_ID]) {
      const transactionId = iastContext[IAST_TRANSACTION_ID]
      return TaintedUtils.isTainted(transactionId, string)
    } else {
      return false
    }
  }

  getRanges (iastContext, string) {
    if (iastContext && iastContext[IAST_TRANSACTION_ID]) {
      const transactionId = iastContext[IAST_TRANSACTION_ID]
      return TaintedUtils.getRanges(transactionId, string)
    }
  }

  enable () {
    global._ddiast = TaintTracking
  }

  disable () {
    global._ddiast = TaintTrackingDummy
  }
}

module.exports = {
  taintOperations: new TaintOperations(),
  IAST_TRANSACTION_ID
}
