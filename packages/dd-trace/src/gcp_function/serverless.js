'use strict'

function isInGCPFunction () {
  const isDeprecatedGCPFunction = process.env.FUNCTION_NAME !== undefined && process.env.GCP_PROJECT !== undefined
  const isNewerGCPFunction = process.env.K_SERVICE !== undefined && process.env.FUNCTION_TARGET !== undefined
  return isDeprecatedGCPFunction || isNewerGCPFunction
}

module.exports = {
  isInGCPFunction
}
