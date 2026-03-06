'use strict'

const zlib = require('zlib')
const pkg = require('../../../../package.json')
const log = require('../log')
const request = require('../exporters/common/request')
const { MsgpackEncoder } = require('../msgpack')
const { getAgentUrl } = require('../agent/url')

const msgpack = new MsgpackEncoder()

function makeRequest (data, url, cb) {
  const options = {
    path: '/v0.1/pipeline_stats',
    method: 'POST',
    headers: {
      'Datadog-Meta-Lang': 'javascript',
      'Datadog-Meta-Tracer-Version': pkg.version,
      'Content-Type': 'application/msgpack',
      'Content-Encoding': 'gzip',
    },
    url,
  }

  log.debug('Request to the intake: %j', options)

  request(data, options, (err, res) => {
    cb(err, res)
  })
}

class DataStreamsWriter {
  #url

  constructor (config) {
    this.#url = getAgentUrl(config)
  }

  flush (payload) {
    if (!request.writable) {
      log.debug('Maximum number of active requests reached. Payload discarded: %j', payload)
      return
    }
    const encodedPayload = msgpack.encode(payload)

    zlib.gzip(encodedPayload, { level: 1 }, (err, compressedData) => {
      if (err) {
        log.error('Error zipping datastream', err)
        return
      }
      makeRequest(compressedData, this.#url, (err, res) => {
        log.debug('Response from the agent:', res)
        if (err) {
          log.error('Error sending datastream', err)
        }
      })
    })
  }

  // Exposed for test access
  get _url () { return this.#url }

  setUrl (url) {
    try {
      url = new URL(url)
      this.#url = url
    } catch (e) {
      log.warn(e.stack)
    }
  }
}

module.exports = {
  DataStreamsWriter,
}
