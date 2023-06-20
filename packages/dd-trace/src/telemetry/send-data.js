const request = require('../exporters/common/request')
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

  const data = JSON.stringify({
    api_version: 'v2',
    naming_schema_version: parseInt(config.namingSchemaVer.charAt(1)),
    request_type: reqType,
    tracer_time: Math.floor(Date.now() / 1000),
    runtime_id: config.tags['runtime-id'],
    seq_id: ++seqId,
    payload: getPayload(payload),
    application,
    host
  })

  request(data, options, (error) => {
    if (error && process.env.DD_API_KEY) {
      const backendHeader = { 'DD-API-KEY': process.env.DD_API_KEY, ...options.headers }
      const backendOptions = {
        url: 'https://all-http-intake.logs.datad0g.com/api/v2/apmtelemetry',
        headers: backendHeader,
        ...options
      }
      request(data, backendOptions, () => {})
    }
  })
}

module.exports = { sendData }
