const { incomingHttpRequestEnd } = require('../gateway/channels')
const { sendVulnerabilities } = require('./vulnerability-reporter')
const web = require('../../plugins/util/web')
const IAST_CONTEXT_KEY = Symbol('_dd.iast.context')

function enable () {
  incomingHttpRequestEnd.subscribe(onIncomingHttpRequestEnd)
}

function disable () {
  if (incomingHttpRequestEnd.hasSubscribers) incomingHttpRequestEnd.unsubscribe(onIncomingHttpRequestEnd)
}

function onIncomingHttpRequestEnd (data) {
  if (data && data.req) {
    const topContext = web.getContext(data.req)
    const iastContext = topContext && topContext[IAST_CONTEXT_KEY]
    if (iastContext) {
      const rootSpan = topContext.span
      sendVulnerabilities(iastContext, rootSpan)
    }
  }
}

module.exports = { enable, disable, onIncomingHttpRequestEnd, IAST_CONTEXT_KEY }
