const vulnerabilityReporter = require('./vulnerability-reporter')
const { enableAllAnalyzers, disableAllAnalyzers } = require('./analyzers')
const web = require('../../plugins/util/web')
const { storage } = require('../../../../datadog-core')
const overheadController = require('./overhead-controller')
const dc = require('../../../../diagnostics_channel')
const iastContextFunctions = require('./iast-context')
const {
  enableTaintTracking,
  disableTaintTracking,
  createTransaction,
  removeTransaction,
  taintTrackingPlugin
} = require('./taint-tracking')
const { IAST_ENABLED_TAG_KEY } = require('./tags')
const iastTelemetry = require('./telemetry')

// TODO Change to `apm:http:server:request:[start|close]` when the subscription
//  order of the callbacks can be enforce
const requestStart = dc.channel('dd-trace:incomingHttpRequestStart')
const requestClose = dc.channel('dd-trace:incomingHttpRequestEnd')
const iastResponseEnd = dc.channel('datadog:iast:response-end')

function enable (config, _tracer) {
  iastTelemetry.configure(config, config.iast && config.iast.telemetryVerbosity)
  enableAllAnalyzers(config)
  enableTaintTracking(config.iast, iastTelemetry.verbosity)
  requestStart.subscribe(onIncomingHttpRequestStart)
  requestClose.subscribe(onIncomingHttpRequestEnd)
  overheadController.configure(config.iast)
  overheadController.startGlobalContext()
  vulnerabilityReporter.start(config, _tracer)
}

function disable () {
  iastTelemetry.stop()
  disableAllAnalyzers()
  disableTaintTracking()
  overheadController.finishGlobalContext()
  if (requestStart.hasSubscribers) requestStart.unsubscribe(onIncomingHttpRequestStart)
  if (requestClose.hasSubscribers) requestClose.unsubscribe(onIncomingHttpRequestEnd)
  vulnerabilityReporter.stop()
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
          iastTelemetry.onRequestStart(iastContext)
          taintTrackingPlugin.taintRequest(data.req, iastContext)
        }
        if (rootSpan.addTags) {
          rootSpan.addTags({
            [IAST_ENABLED_TAG_KEY]: isRequestAcquired ? 1 : 0
          })
        }
      }
    }
  }
}

function onIncomingHttpRequestEnd (data) {
  if (data && data.req) {
    const store = storage.getStore()
    const topContext = web.getContext(data.req)
    const iastContext = iastContextFunctions.getIastContext(store, topContext)
    if (iastContext && iastContext.rootSpan) {
      iastResponseEnd.publish(data)

      const vulnerabilities = iastContext.vulnerabilities
      const rootSpan = iastContext.rootSpan
      vulnerabilityReporter.sendVulnerabilities(vulnerabilities, rootSpan)
      removeTransaction(iastContext)
      iastTelemetry.onRequestEnd(iastContext, iastContext.rootSpan)
    }
    // TODO web.getContext(data.req) is required when the request is aborted
    if (iastContextFunctions.cleanIastContext(store, topContext, iastContext)) {
      overheadController.releaseRequest()
    }
  }
}

module.exports = { enable, disable, onIncomingHttpRequestEnd, onIncomingHttpRequestStart }
