const { incomingHttpRequestStart, incomingHttpRequestEnd } = require('../gateway/channels')
const { sendVulnerabilities } = require('./vulnerability-reporter')
const web = require('../../plugins/util/web')
const IAST_CONTEXT_KEY = Symbol('_dd.iast.context')
const { storage } = require('../../../../datadog-core')
const overheadController = require('./overhead-controller')

function enable () {
  incomingHttpRequestEnd.subscribe(onIncomingHttpRequestEnd)
  incomingHttpRequestStart.subscribe(onIncomingHttpRequestStart)
  overheadController.startGlobalContextResetInterval()
}

function disable () {
  if (incomingHttpRequestEnd.hasSubscribers) incomingHttpRequestEnd.unsubscribe(onIncomingHttpRequestEnd)
  if (incomingHttpRequestStart.hasSubscribers) incomingHttpRequestStart.unsubscribe(onIncomingHttpRequestStart)
  overheadController.stopGlobalContextResetInterval()
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
          store[IAST_CONTEXT_KEY] = { rootSpan, req: data.req }
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
      sendVulnerabilities(iastContext, iastContext.rootSpan)
    }
  }
}

module.exports = { enable, disable, onIncomingHttpRequestEnd, onIncomingHttpRequestStart, IAST_CONTEXT_KEY }
