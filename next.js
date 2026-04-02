'use strict'

const { withDatadogServerAction } = require('./packages/datadog-plugin-next/src/serverAction')
const { getDatadogTraceMetadata } = require('./packages/datadog-plugin-next/src/traceMetadata')
const { datadogOnRequestError } = require('./packages/datadog-plugin-next/src/requestError')

module.exports = {
  withDatadogServerAction,
  getDatadogTraceMetadata,
  datadogOnRequestError
}
