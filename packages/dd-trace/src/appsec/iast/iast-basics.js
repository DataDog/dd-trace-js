'use strict'
const dc = require('dc-polyfill')
const { enableBasicAnalyzers, disableBasicAnalyzers } = require('./analyzers/basics')
const { storage } = require('../../../../datadog-core')
const overheadController = require('./overhead-controller')
const web = require('../../plugins/util/web')
const { IAST_ENABLED_TAG_KEY } = require('./tags')
const iastContextFunctions = require('./iast-context')
const vulnerabilityReporter = require('./vulnerability-reporter')

const requestStart = dc.channel('dd-trace:incomingHttpRequestStart')
const requestClose = dc.channel('dd-trace:incomingHttpRequestEnd')

let isEnabled = false
function enable () {
  enableBasicAnalyzers()
  overheadController.configure({ maxConcurrentRequests: 1 })
  requestStart.subscribe(onIncomingHttpRequestStart)
  requestClose.subscribe(onIncomingHttpRequestEnd)
  isEnabled = true
}

function disable () {
  if (isEnabled) {
    disableBasicAnalyzers()
    if (requestStart.hasSubscribers) requestStart.unsubscribe(onIncomingHttpRequestStart)
    if (requestClose.hasSubscribers) requestClose.unsubscribe(onIncomingHttpRequestEnd)
    isEnabled = false
  }
}

function onIncomingHttpRequestStart (data) {
  if (data?.req) {
    const store = storage.getStore()
    if (store) {
      const topContext = web.getContext(data.req)
      const rootSpan = topContext.span
      const isRequestAcquired = overheadController.acquireRequest(rootSpan, 100)
      if (isRequestAcquired) {
        const iastContext = iastContextFunctions.saveIastContext(store, topContext, { rootSpan, req: data.req })
        overheadController.initializeRequestContext(iastContext)
      }
    }
  }
}

function onIncomingHttpRequestEnd (data) {
  if (data?.req) {
    const store = storage.getStore()
    const topContext = web.getContext(data.req)
    const iastContext = iastContextFunctions.getIastContext(store, topContext)
    if (iastContext?.rootSpan) {
      const vulnerabilities = iastContext.vulnerabilities
      const rootSpan = iastContext.rootSpan
      vulnerabilityReporter.sendVulnerabilities(vulnerabilities, rootSpan)
      rootSpan.addTags({
        [IAST_ENABLED_TAG_KEY]: 1
      })
    }
    if (iastContextFunctions.cleanIastContext(store, topContext, iastContext)) {
      overheadController.releaseRequest()
    }
  }
}

module.exports = {
  enable,
  disable
}
