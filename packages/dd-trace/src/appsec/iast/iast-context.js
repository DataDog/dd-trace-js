'use strict'

const IAST_CONTEXT_KEY = Symbol('_dd.iast.context')
const IAST_TRANSACTION_ID = Symbol('_dd.iast.transactionId')

function getIastContext (store, topContext) {
  let iastContext = store && store[IAST_CONTEXT_KEY]
  if (!iastContext) {
    iastContext = topContext && topContext[IAST_CONTEXT_KEY]
  }
  return iastContext
}

function getIastStackTraceId (iastContext) {
  if (!iastContext) return '0'

  if (!iastContext.stackTraceId) {
    iastContext.stackTraceId = 0
  }

  iastContext.stackTraceId += 1
  return String(iastContext.stackTraceId)
}

/* TODO Fix storage problem when the close event is called without
        finish event to remove `topContext` references
  We have to save the context in two places, because
  clean can be called when the storage store is not available
 */
function saveIastContext (store, topContext, context) {
  if (store && topContext) {
    store[IAST_CONTEXT_KEY] = context
    topContext[IAST_CONTEXT_KEY] = context
    return store[IAST_CONTEXT_KEY]
  }
}

/* TODO Fix storage problem when the close event is called without
        finish event to remove `topContext` references
  iastContext is currently saved in store and request rootContext
  to fix problems with `close` without `finish` events
*/
function cleanIastContext (store, context, iastContext) {
  if (store) {
    if (!iastContext) {
      iastContext = store[IAST_CONTEXT_KEY]
    }
    store[IAST_CONTEXT_KEY] = null
  }
  if (context) {
    if (!iastContext) {
      iastContext = context[IAST_CONTEXT_KEY]
    }
    context[IAST_CONTEXT_KEY] = null
  }
  if (iastContext) {
    if (typeof iastContext === 'object') { // eslint-disable-line eslint-rules/eslint-safe-typeof-object
      Object.keys(iastContext).forEach(key => delete iastContext[key])
    }
    return true
  }
  return false
}

module.exports = {
  getIastContext,
  saveIastContext,
  cleanIastContext,
  getIastStackTraceId,
  IAST_CONTEXT_KEY,
  IAST_TRANSACTION_ID
}
