
const request = require('../exporters/common/request')
const log = require('../log')
let agentTelemetry = true

function getHeaders (config, application, reqType) {
  const headers = {
    'content-type': 'application/json',
    'dd-telemetry-api-version': 'v2',
    'dd-telemetry-request-type': reqType,
    'dd-client-library-language': application.language_name,
    'dd-client-library-version': application.tracer_version
  }
  const debug = config.telemetry && config.telemetry.debug
  if (debug) {
    headers['dd-telemetry-debug-enabled'] = 'true'
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

function sendData (config, application, host, reqType, payload = {}, cb = () => {}) {
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
    api_version: 'v2',
    naming_schema_version: config.spanAttributeSchema ? config.spanAttributeSchema : '',
    request_type: reqType,
    tracer_time: Math.floor(Date.now() / 1000),
    runtime_id: config.tags['runtime-id'],
    seq_id: ++seqId,
    payload: getPayload(payload),
    application,
    host
  })

  request(data, options, (error) => {
    if (error && process.env.DD_API_KEY && config.site) {
      if (agentTelemetry) {
        log.info('Agent telemetry failed, started agentless telemetry')
        agentTelemetry = false
      }
      // figure out which data center to send to
      let prefix
      if (config.site) {
        if (config.site.endsWith('datad0g.com')) {
          prefix = 'all-http-intake.logs.'
        } else if (config.site.endsWith('datadoghq.com')) {
          prefix = 'instrumentation-telemetry-intake.'
        }
      }
      const backendUrl = 'https://' + prefix + config.site + '/api/v2/apmtelemetry'
      const backendHeader = { ...options.headers, 'DD-API-KEY': process.env.DD_API_KEY }
      const backendOptions = {
        ...options,
        url: backendUrl,
        headers: backendHeader
      }
      request(data, backendOptions, (error) => { log.error(error) })
    }

    if (!error && !agentTelemetry) {
      agentTelemetry = true
      log.info('Started agent telemetry')
    }

    // call the callback function so that we can track the error and payload
    cb(error, { 'payload': payload, reqType: reqType })
  })
}

module.exports = { sendData }
