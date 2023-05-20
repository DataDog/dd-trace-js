'use strict'

// const { enableOptOutAnalyzers, disableOptOutAnalyzers } = require('./analyzers')
const overheadController = require('./overhead-controller')
const dc = require('../../../../diagnostics_channel')
const { storage } = require('../../../../datadog-core')
const web = require('../../plugins/util/web')
const iastContextFunctions = require('./iast-context')
const vulnerabilityReporter = require('./vulnerability-reporter')
const IAST_ENABLED_TAG_KEY = '_dd.iast.enabled'

const requestStart = dc.channel('dd-trace:incomingHttpRequestStart')
const requestClose = dc.channel('dd-trace:incomingHttpRequestEnd')

function enable (config, _tracer) {
  // requestStart.subscribe(onIncomingHttpRequestStart)
  overheadController.configure(config.iast)
  // overheadController.startGlobalContext()
}

let isInIastRequest = false
//
// function onIncomingHttpRequestStart (data) {
//   if (!isInIastRequest && Math.random() < 0) {
//     isInIastRequest = true
//     if (data && data.req) {
//       const store = storage.getStore()
//       if (store) {
//         const topContext = web.getContext(data.req)
//         if (topContext) {
//           const rootSpan = topContext.span
//           const iastContext = iastContextFunctions.saveIastContext(store, topContext, { rootSpan, req: data.req })
//           overheadController.initializeRequestContext(iastContext)
//           if (rootSpan.addTags) {
//             rootSpan.addTags({
//               [IAST_ENABLED_TAG_KEY]: 1
//             })
//           }
//           enableOptOutAnalyzers()
//           requestClose.subscribe(onIncomingHttpRequestEnd)
//         }
//       }
//     }
//   }
// }
//
function onIncomingHttpRequestEnd (data) {
  if (data && data.req) {
    const store = storage.getStore()
    const topContext = web.getContext(data.req)
    const iastContext = iastContextFunctions.getIastContext(store, topContext)
    if (iastContext && iastContext.rootSpan) {
      // getHttpResponseAnalyzers().forEach(analyzer => {
      //   analyzer.analyze(data.res)
      // })
      const vulnerabilities = iastContext.vulnerabilities
      const rootSpan = iastContext.rootSpan
      vulnerabilityReporter.sendVulnerabilities(vulnerabilities, rootSpan)
      disableOptOutAnalyzers()
      isInIastRequest = false
      requestClose.unsubscribe(onIncomingHttpRequestEnd)
      // TODO web.getContext(data.req) is required when the request is aborted
      if (iastContextFunctions.cleanIastContext(store, topContext, iastContext)) {
        overheadController.releaseRequest()
      }
    }
  }
}

module.exports = { enable }
