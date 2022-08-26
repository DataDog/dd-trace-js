const { sendVulnerabilities } = require('./vulnerability-reporter')
const { enableAllAnalyzers, disableAllAnalyzers } = require('./analyzers')
const web = require('../../plugins/util/web')
const { storage } = require('../../../../datadog-core')
const overheadController = require('./overhead-controller')
const dc = require('diagnostics_channel')
const { saveIastContext, getIastContext, cleanIastContext } = require('./iast-context')

const requestStart = dc.channel('apm:http:server:request:start')
const requestClose = dc.channel('apm:http:server:request:close')

function enable (config) {
  enableAllAnalyzers()
  requestClose.subscribe(onIncomingHttpRequestEnd)
  setImmediate(() => {
    requestStart.subscribe(onIncomingHttpRequestStart)
  })
  overheadController.configureOCE(config.iast.oce)
}

function disable () {
  disableAllAnalyzers()
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
          const iastContext = saveIastContext(store, topContext, { rootSpan, req: data.req })
          overheadController.initializeRequestContext(iastContext)
        }
      }
    }
  }
}

function onIncomingHttpRequestEnd (data) {
  if (data && data.req) {
    const store = storage.getStore()
    const iastContext = getIastContext(storage.getStore())
    if (iastContext && iastContext.rootSpan) {
      overheadController.releaseRequest()
      sendVulnerabilities(iastContext, iastContext.rootSpan)
    }
    // TODO web.getContext(data.req) is required when the request is aborted
    if (cleanIastContext(store, web.getContext(data.req), iastContext)) {
      overheadController.releaseRequest()
    }
  }
}

module.exports = { enable, disable, onIncomingHttpRequestEnd, onIncomingHttpRequestStart }
