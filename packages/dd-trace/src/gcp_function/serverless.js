'use strict'

function isInGCPFunction () {
  const isDeprecatedGCPFunction = process.env.FUNCTION_NAME !== undefined && process.env.GCP_PROJECT !== undefined
  const isNewerGCPFunction = process.env.K_SERVICE !== undefined && process.env.FUNCTION_TARGET !== undefined
  console.log('is in gcp function? ' + isDeprecatedGCPFunction || isNewerGCPFunction)
  return isDeprecatedGCPFunction || isNewerGCPFunction
}

module.exports = {
  isInGCPFunction
}
