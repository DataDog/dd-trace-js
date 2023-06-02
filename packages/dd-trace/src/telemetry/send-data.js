const request = require('../exporters/common/request')
const tracerConfig = require('../config')
let seqId = 0

function getPayload (payload) {
  // Some telemetry endpoints payloads accept collections of elements such as the 'logs' endpoint.
  // 'logs' request type payload is meant to send library logs to Datadog’s backend.
  if (Array.isArray(payload)) {
    return payload
  } else {
    const { logger, tags, serviceMapping, ...trimmedPayload } = payload
    return trimmedPayload
  }
}

function sendData (config, application, host, reqType, payload = {}) {
  const {
    hostname,
    port,
    url
  } = config

  const options = {
    url,
    hostname,
    port,
    method: 'POST',
    path: '/telemetry/proxy/api/v2/apmtelemetry',
    headers: {
      'content-type': 'application/json',
      'dd-telemetry-api-version': 'v2',
      'dd-telemetry-request-type': reqType
    }
  }

  let namingSchemaVer = tracerConfig.DD_TRACE_SPAN_ATTRIBUTE_SCHEMA
  if (namingSchemaVer) {
    namingSchemaVer = parseInt(namingSchemaVer.charAt(1))
  } else {
    namingSchemaVer = 0
  }
  const data = JSON.stringify({
    api_version: 'v2',
    naming_schema_version: namingSchemaVer,
    request_type: reqType,
    tracer_time: Math.floor(Date.now() / 1000),
    runtime_id: config.tags['runtime-id'],
    seq_id: ++seqId,
    payload: getPayload(payload),
    application,
    host
  })

  request(data, options, () => {
    // ignore errors
  })
}

module.exports = { sendData }
