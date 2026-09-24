'use strict'

const { wrapHandler } = require('../../../datadog-instrumentations/src/aws-lambda')

/**
 * Patches your AWS Lambda handler function to add some tracing support.
 *
 * @param {Function} lambdaHandler a Lambda handler function.
 */
exports.datadog = function datadog (lambdaHandler) {
  return wrapHandler(lambdaHandler)
}
