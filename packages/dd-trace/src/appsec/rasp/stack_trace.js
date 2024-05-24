'use strict'

// TODO Copied from packages/dd-trace/src/appsec/iast/path-line.js, extract to a common file
function getCallSiteInfo () {
  const previousPrepareStackTrace = Error.prepareStackTrace
  const previousStackTraceLimit = Error.stackTraceLimit
  let callsiteList
  Error.stackTraceLimit = 32 // TODO load from config
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

function generateStackTraceForMetaStruct () {
  const callSites = getCallSiteInfo()
  let i = 0
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
