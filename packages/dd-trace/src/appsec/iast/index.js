const { sendVulnerabilities } = require('./vulnerability-reporter')
const { enableAllAnalyzers, disableAllAnalyzers } = require('./analyzers')
const web = require('../../plugins/util/web')
const { storage } = require('../../../../datadog-core')
const overheadController = require('./overhead-controller')
const dc = require('diagnostics_channel')
const iastContextFunctions = require('./iast-context')
const { createTransaction, removeTransaction, enableTaintTracking } = require('./taint-tracking')
// TODO Change to `apm:http:server:request:[start|close]` when the subscription
//  order of the callbacks can be enforce
const requestStart = dc.channel('dd-trace:incomingHttpRequestStart')
const requestClose = dc.channel('dd-trace:incomingHttpRequestEnd')

function enable (config) {
  enableAllAnalyzers()
  enableTaintTracking(true)
  requestStart.subscribe(onIncomingHttpRequestStart)
  requestClose.subscribe(onIncomingHttpRequestEnd)
  overheadController.configure(config.iast)
}

function disable () {
  disableAllAnalyzers()
  enableTaintTracking(false)
  if (requestStart.hasSubscribers) requestStart.unsubscribe(onIncomingHttpRequestStart)
  if (requestClose.hasSubscribers) requestClose.unsubscribe(onIncomingHttpRequestEnd)
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
          const iastContext = iastContextFunctions.saveIastContext(store, topContext, { rootSpan, req: data.req })
          createTransaction(rootSpan.context().toSpanId(), iastContext)
          overheadController.initializeRequestContext(iastContext)
        }
      }
    }
  }
}

function onIncomingHttpRequestEnd (data) {
  if (data && data.req) {
    const store = storage.getStore()
    const iastContext = iastContextFunctions.getIastContext(storage.getStore())
    if (iastContext && iastContext.rootSpan) {
      sendVulnerabilities(iastContext, iastContext.rootSpan)
      removeTransaction(iastContext)
    }
    // TODO web.getContext(data.req) is required when the request is aborted
    if (iastContextFunctions.cleanIastContext(store, web.getContext(data.req), iastContext)) {
      overheadController.releaseRequest()
    }
  }
}

module.exports = { enable, disable, onIncomingHttpRequestEnd, onIncomingHttpRequestStart }
