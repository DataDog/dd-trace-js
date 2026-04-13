'use strict'

const { withDatadogServerAction } = require('./packages/datadog-plugin-next/src/server-action')
const { getDatadogTraceMetadata } = require('./packages/datadog-plugin-next/src/trace-metadata')
const { datadogOnRequestError } = require('./packages/datadog-plugin-next/src/request-error')

module.exports = {
  withDatadogServerAction,
  getDatadogTraceMetadata,
  datadogOnRequestError,
}
