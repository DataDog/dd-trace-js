const pkg = require('../../../../package.json')
const log = require('../log')
const request = require('../exporters/common/request')
const { URL, format } = require('url')
const msgpack = require('msgpack-lite')
const zlib = require('zlib')
const codec = msgpack.createCodec({ int64: true })

function makeRequest (data, url, cb) {
  const options = {
    path: '/v0.1/pipeline_stats',
    method: 'POST',
    headers: {
      'Datadog-Meta-Lang': 'javascript',
      'Datadog-Meta-Tracer-Version': pkg.version,
      'Content-Type': 'application/msgpack',
      'Content-Encoding': 'gzip'
    },
    url
  }

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
    const encodedPayload = msgpack.encode(payload, { codec })

    zlib.gzip(encodedPayload, { level: 1 }, (err, compressedData) => {
      if (err) {
        log.error(err)
        return
      }
      makeRequest(compressedData, this._url, (err, res) => {
        log.debug(`Response from the agent: ${res}`)
        if (err) {
          log.error(err)
        }
      })
    })
  }

  setUrl (url) {
    try {
      url = new URL(url)
      this._url = url
    } catch (e) {
      log.warn(e.stack)
    }
  }
}

module.exports = {
  DataStreamsWriter
}
