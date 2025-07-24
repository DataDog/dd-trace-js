'use strict'

const vulnerabilityReporter = require('./vulnerability-reporter')
const { enableAllAnalyzers, disableAllAnalyzers } = require('./analyzers')
const web = require('../../plugins/util/web')
const { storage } = require('../../../../datadog-core')
const overheadController = require('./overhead-controller')
const dc = require('dc-polyfill')
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
const { enable: enableFsPlugin, disable: disableFsPlugin, IAST_MODULE } = require('../rasp/fs-plugin')
const securityControls = require('./security-controls')
const { incomingHttpRequestStart, incomingHttpRequestEnd, responseWriteHead } = require('../channels')

const collectedResponseHeaders = new WeakMap()

// TODO Change to `apm:http:server:request:[start|close]` when the subscription
//  order of the callbacks can be enforce
const iastResponseEnd = dc.channel('datadog:iast:response-end')
let isEnabled = false

function enable (config, _tracer) {
  if (isEnabled) return

  iastTelemetry.configure(config, config.iast?.telemetryVerbosity)
  enableFsPlugin(IAST_MODULE)
  enableAllAnalyzers(config)
  enableTaintTracking(config.iast, iastTelemetry.verbosity)
  incomingHttpRequestStart.subscribe(onIncomingHttpRequestStart)
  incomingHttpRequestEnd.subscribe(onIncomingHttpRequestEnd)
  responseWriteHead.subscribe(onResponseWriteHeadCollect)
  overheadController.configure(config.iast)
  overheadController.startGlobalContext()
  securityControls.configure(config.iast)
  vulnerabilityReporter.start(config, _tracer)

  isEnabled = true
}

function disable () {
  if (!isEnabled) return

  isEnabled = false

  iastTelemetry.stop()
  disableFsPlugin(IAST_MODULE)
  disableAllAnalyzers()
  disableTaintTracking()
  overheadController.finishGlobalContext()
  if (incomingHttpRequestStart.hasSubscribers) incomingHttpRequestStart.unsubscribe(onIncomingHttpRequestStart)
  if (incomingHttpRequestEnd.hasSubscribers) incomingHttpRequestEnd.unsubscribe(onIncomingHttpRequestEnd)
  if (responseWriteHead.hasSubscribers) responseWriteHead.unsubscribe(onResponseWriteHeadCollect)
  vulnerabilityReporter.stop()
}

function onIncomingHttpRequestStart (data) {
  if (data?.req) {
    const store = storage('legacy').getStore()
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
  if (data?.req) {
    const store = storage('legacy').getStore()
    const topContext = web.getContext(data.req)
    const iastContext = iastContextFunctions.getIastContext(store, topContext)
    if (iastContext?.rootSpan) {
      const storedHeaders = collectedResponseHeaders.get(data.res) || {}

      iastResponseEnd.publish({ ...data, storedHeaders })

      if (Object.keys(storedHeaders).length) {
        collectedResponseHeaders.delete(data.res)
      }

      const vulnerabilities = iastContext.vulnerabilities
      const rootSpan = iastContext.rootSpan
      vulnerabilityReporter.sendVulnerabilities(vulnerabilities, rootSpan)
      overheadController.consolidateVulnerabilities(iastContext)
      removeTransaction(iastContext)
      iastTelemetry.onRequestEnd(iastContext, iastContext.rootSpan)
    }
    // TODO web.getContext(data.req) is required when the request is aborted
    if (iastContextFunctions.cleanIastContext(store, topContext, iastContext)) {
      overheadController.releaseRequest()
    }
  }
}

// Response headers are collected here because they are not available in the onIncomingHttpRequestEnd when using Fastify
function onResponseWriteHeadCollect ({ res, responseHeaders = {} }) {
  if (!res) return

  if (Object.keys(responseHeaders).length) {
    collectedResponseHeaders.set(res, responseHeaders)
  }
}

module.exports = { enable, disable, onIncomingHttpRequestEnd, onIncomingHttpRequestStart }
