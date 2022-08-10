const { sendVulnerabilities } = require('./vulnerability-reporter')
const { enableAllAnalyzers, disableAllAnalyzers } = require('./analyzers')
const web = require('../../plugins/util/web')
const { storage } = require('../../../../datadog-core')
const overheadController = require('./overhead-controller')
const dc = require('diagnostics_channel')

const IAST_CONTEXT_KEY = Symbol('_dd.iast.context')
const requestStart = dc.channel('apm:http:server:request:start')
const requestFinish = dc.channel('apm:http:server:request:finish')
const requestClose = dc.channel('apm:http:server:request:close')

function enable (config) {
  enableAllAnalyzers()

  requestStart.subscribe(onIncomingHttpRequestStart)
  requestFinish.subscribe(onIncomingHttpRequestEnd)
  requestClose.subscribe(onIncomingHttpRequestClose)

  overheadController.configureOCE(config.iast.oce)
  overheadController.startGlobalContextResetScheduler()
}

function disable () {
  disableAllAnalyzers()

  if (requestStart.hasSubscribers) requestStart.unsubscribe(onIncomingHttpRequestStart)
  if (requestFinish.hasSubscribers) requestFinish.unsubscribe(onIncomingHttpRequestEnd)
  if (requestClose.hasSubscribers) requestClose.unsubscribe(onIncomingHttpRequestClose)
  overheadController.stopGlobalContextResetScheduler()
}

function onIncomingHttpRequestStart (data) {
  if (data && data.req) {
    const store = storage.getStore()
    if (store) {
      const topContext = web.getContext(data.req)
      if (topContext) {
        const rootSpan = topContext.span
        const isRequestAcquired = overheadController.acquireRequest(rootSpan)
        if (isRequestAcquired) {
          const iastContext = { rootSpan, req: data.req }
          topContext[IAST_CONTEXT_KEY] = iastContext
          store[IAST_CONTEXT_KEY] = iastContext
          overheadController.initializeRequestContext(store[IAST_CONTEXT_KEY])
        }
      }
    }
  }
}

function onIncomingHttpRequestEnd (data) {
  if (data && data.req) {
    const store = storage.getStore()
    const iastContext = store && store[IAST_CONTEXT_KEY]
    if (iastContext && iastContext.rootSpan) {
      overheadController.releaseRequest()
      sendVulnerabilities(iastContext, iastContext.rootSpan)
    }
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
    overheadController.releaseRequest()
    Object.keys(iastContext).forEach(key => delete iastContext[key])
  }
}

function onIncomingHttpRequestClose (data) {
  if (data && data.req) {
    cleanIastContext(storage.getStore(), web.getContext(data.req))
  }
}

module.exports = { enable, disable, onIncomingHttpRequestEnd, onIncomingHttpRequestStart, IAST_CONTEXT_KEY }
