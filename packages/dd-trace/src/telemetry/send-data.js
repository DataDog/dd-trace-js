const request = require('../exporters/common/request')
let seqId = 0
function sendData (config, application, host, reqType, payload = {}) {
  const {
    hostname,
    port
  } = config
  const options = {
    hostname,
    port,
    method: 'POST',
    path: '/telemetry/proxy/api/v2/apmtelemetry',
    headers: {
      'content-type': 'application/json',
      'dd-telemetry-api-version': 'v1',
      'dd-telemetry-request-type': reqType
    }
  }
  const data = JSON.stringify({
    api_version: 'v1',
    request_type: reqType,
    tracer_time: Math.floor(Date.now() / 1000),
    runtime_id: config.tags['runtime-id'],
    seq_id: ++seqId,
    payload,
    application,
    host
  })

  request(data, options, true, () => {
    // ignore errors
  })
}

module.exports = { sendData }
