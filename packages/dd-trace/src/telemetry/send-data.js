const request = require('../exporters/common/request')

function getHeaders (config, application, reqType) {
  const headers = {
    'Content-Type': 'application/json',
    'DD-Telemetry-API-Version': 'v2',
    'DD-Telemetry-Request-Type': reqType,
    'DD-Client-Library-Language': application.language_name,
    'DD-Client-Library-Version': application.tracer_version
  }
  const debug = config.telemetry && config.telemetry.debug
  if (debug) {
    headers['DD-Telemetry-Debug-Enabled'] = 'true'
  }
  return headers
}

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
    headers: getHeaders(config, application, reqType)
  }
  const data = JSON.stringify({
    api_version: 'v1',
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
