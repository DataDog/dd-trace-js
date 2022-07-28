const { incomingHttpRequestStart, incomingHttpRequestEnd } = require('../gateway/channels')
const { sendVulnerabilities } = require('./vulnerability-reporter')
const web = require('../../plugins/util/web')
const IAST_CONTEXT_KEY = Symbol('_dd.iast.context')
const { storage } = require('../../../../datadog-core')

function enable () {
  incomingHttpRequestEnd.subscribe(onIncomingHttpRequestEnd)
  incomingHttpRequestStart.subscribe(onIncomingHttpRequestStart)
}

function disable () {
  if (incomingHttpRequestEnd.hasSubscribers) incomingHttpRequestEnd.unsubscribe(onIncomingHttpRequestEnd)
  if (incomingHttpRequestStart.hasSubscribers) incomingHttpRequestStart.unsubscribe(onIncomingHttpRequestStart)
}

function onIncomingHttpRequestStart (data) {
  // TODO Add OCE check
  if (data && data.req) {
    const store = storage.getStore()
    if (store) {
      const topContext = web.getContext(data.req)
      if (topContext) {
        const rootSpan = topContext.span
        store[IAST_CONTEXT_KEY] = { rootSpan, req: data.req }
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
