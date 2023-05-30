const pkg = require('../../../../package.json')
const log = require('../log')
const request = require('../exporters/common/request')
const { URL, format } = require('url')
const pako = require('pako')
const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })

function makeRequest (data, url, cb) {
  console.log("sending payload", data)
  const options = {
    path: '/v0.1/pipeline_stats',
    method: 'POST',
    headers: {
      'Datadog-Meta-Lang': 'javascript',
      'Datadog-Meta-Tracer-Version': pkg.version,
      'Content-Type': 'application/msgpack',
      'Content-Encoding': 'gzip'
    }
  }

  options.protocol = url.protocol
  options.hostname = url.hostname
  options.port = url.port

  log.debug(() => `Request to the intake: ${JSON.stringify(options)}`)

  request(data, options, (err, res) => {
    cb(err, res)
  })
}

class DataStreamsWriter {
  constructor (config) {
    const { hostname = '127.0.0.1', port = 8126, url } = config
    this._url = url || new URL(format({
      protocol: 'http:',
      hostname: hostname || 'localhost',
      port
    }))
  }

  flush (payload) {
    if (!request.writable) {
      log.debug(() => `Maximum number of active requests reached. Payload discarded: ${JSON.stringify(payload)}`)
      return
    }
    console.log("payload is ", payload)
    console.log("_________________________")
    console.log("encoded is ", msgpack.encode(payload, { codec }))
    const encoded = pako.gzip(msgpack.encode(payload, { codec }), { level: 1 })
    makeRequest(encoded, this._url, (err, res) => {
      log.debug(`Response from the intake: ${res}`)
      console.log("response is ", res)
      if (err) {
        log.error(err)
      }
    })
  }
}

module.exports = {
  DataStreamsWriter
}
