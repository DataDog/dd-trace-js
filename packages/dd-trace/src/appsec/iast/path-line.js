const path = require('path')
const pathLine = {
  getFirstNonDDPathAndLine,
  getFirstNonDDPathAndLineFromCallsites, // Exported only for test purposes
  calculateDDBasePath, // Exported only for test purposes
  ddBasePath: calculateDDBasePath(__dirname) // Only for test purposes
}

function calculateDDBasePath (dirname) {
  const dirSteps = dirname.split(path.sep)
  const packagesIndex = dirSteps.indexOf('packages')
  return dirSteps.slice(0, packagesIndex).join(path.sep) + path.sep
}

function getCallSiteInfo () {
  const previousPrepareStackTrace = Error.prepareStackTrace
  let callsiteList
  Error.prepareStackTrace = function (_, callsites) {
    callsiteList = callsites
  }
  const e = new Error()
  e.stack
  Error.prepareStackTrace = previousPrepareStackTrace
  return callsiteList
}

function getFirstNonDDPathAndLineFromCallsites (callsites) {
  if (callsites) {
    for (let i = 0; i < callsites.length; i++) {
      const callsite = callsites[i]
      const path = callsite.getFileName()
      if (path.indexOf(pathLine.ddBasePath) === -1) {
        return {
          path,
          line: callsite.getLineNumber()
        }
      }
    }
  }
  return null
}

function getFirstNonDDPathAndLine () {
  return getFirstNonDDPathAndLineFromCallsites(getCallSiteInfo())
}
module.exports = pathLine
