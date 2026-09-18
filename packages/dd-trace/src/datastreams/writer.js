'use strict'

const zlib = require('zlib')
const pkg = require('../../../../package.json')
const log = require('../log')
const request = require('../exporters/common/request')
const { encode: encodeMsgpack, MAX_SIZE: MAX_CHUNK_SIZE } = require('../msgpack')

function makeRequest (data, url, resetController, cb) {
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
  if (resetController) options.resetController = resetController

  log.debug('Request to the intake: %j', options)

  request(data, options, (err, res) => {
    cb(err, res)
  })
}

class DataStreamsWriter {
  constructor (config) {
    this._url = config.url
    // The common request controller is shared with other direct MicroVM requests.
    this._resetController = request.getIdentityRefreshController?.()
  }

  flush (payload) {
    if (!request.writable) {
      log.debug('Maximum number of active requests reached. Payload discarded: %j', payload)
      return
    }

    let encodedPayload
    try {
      encodedPayload = encodeMsgpack(payload)
    } catch (error) {
      if (error.code !== 'ERR_MSGPACK_CHUNK_OVERFLOW') throw error
      // The msgpack-encoded pipeline-stats payload exceeded the agent
      // intake cap. Dropping it locally is safer than letting the
      // RangeError crash the host process; the agent would reject the
      // oversized payload at the network boundary anyway.
      log.error('DataStreamsWriter dropped a payload that exceeded the %d byte chunk cap', MAX_CHUNK_SIZE)
      return
    }

    // A pending gzip callback may finish after a MicroVM clone starts; discard that payload before
    // sending it because it belongs to the previous runtime ID. No controller exists otherwise.
    const identityRefreshGeneration = this._resetController?.generation
    zlib.gzip(encodedPayload, { level: 1 }, (err, compressedData) => {
      if (err) {
        log.error('Error zipping datastream', err)
        return
      }
      if (this._resetController && identityRefreshGeneration !== this._resetController.generation) return
      makeRequest(compressedData, this._url, this._resetController, (err, res) => {
        log.debug('Response from the agent:', res)
        if (err && err.code !== 'ERR_DD_IDENTITY_REFRESH') {
          log.error('Error sending datastream', err)
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
  DataStreamsWriter,
}
