'use strict'

// TODO Copied from packages/dd-trace/src/appsec/iast/path-line.js, extract to a common file
function getCallSiteInfo () {
  const previousPrepareStackTrace = Error.prepareStackTrace
  const previousStackTraceLimit = Error.stackTraceLimit
  let callsiteList
  Error.stackTraceLimit = 100
  try {
    Error.prepareStackTrace = function (_, callsites) {
      callsiteList = callsites
    }
    const e = new Error()
    e.stack
  } finally {
    Error.prepareStackTrace = previousPrepareStackTrace
    Error.stackTraceLimit = previousStackTraceLimit
  }
  return callsiteList
}

function generateStackTraceForMetaStruct (maxCallSite = 32) {
  let callSites = getCallSiteInfo()
  let i = 0
  if (callSites.length > maxCallSite) {
    const half = Math.round(maxCallSite / 2)
    callSites = callSites.slice(0, half).concat(callSites.slice(-half))
  }
  return callSites.map(callSite => {
    return {
      id: i++,
      file: callSite.getFileName(),
      line: callSite.getLineNumber(),
      column: callSite.getColumnNumber(),
      function: callSite.getFunctionName()
    }
  })
}

module.exports = {
  generateStackTraceForMetaStruct
}
