const IAST_CONTEXT_KEY = Symbol('_dd.iast.context')

function getIastContext (store) {
  return store && store[IAST_CONTEXT_KEY]
}

function saveIastContext (store, topContext, context) {
  if (store && topContext) {
    store[IAST_CONTEXT_KEY] = context
    topContext[IAST_CONTEXT_KEY] = context
    return store[IAST_CONTEXT_KEY]
  }
}

function cleanIastContext (store, context) {
  let iastContext
  if (store) {
    iastContext = store[IAST_CONTEXT_KEY]
    store[IAST_CONTEXT_KEY] = null
  }
  if (context) {
    if (!iastContext) {
      iastContext = context[IAST_CONTEXT_KEY]
    }
    context[IAST_CONTEXT_KEY] = null
  }
  if (iastContext) {
    Object.keys(iastContext).forEach(key => delete iastContext[key])
    return true
  }
  return false
}

module.exports = {
  getIastContext,
  saveIastContext,
  cleanIastContext,
  IAST_CONTEXT_KEY
}
