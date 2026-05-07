'use strict'

const path = require('path')
const log = require('../../log')
const BaseWriter = require('../common/writer')
const AgentEncoder = require('../../encode/0.4').AgentEncoder

class WasmWriter extends BaseWriter {
  constructor (...args) {
    super(...args)
    const { prioritySampler, config = {} } = args[0]

    this._prioritySampler = prioritySampler
    this._config = config
    this._encoder = new AgentEncoder(this)
    this._jsExporter = null
  }

  setJsExporter (exporter) {
    this._jsExporter = exporter
  }

  _sendPayload (data, count, done) {
    if (!this._jsExporter) {
      log.error('Wasm exporter not initialized')
      done()
      return
    }

    const payload = new Uint8Array(data)
    this._jsExporter.send(payload)
      .then(res => {
        if (res != null && res !== '') {
          try {
            const parsed = JSON.parse(res)
            if (parsed.rate_by_service) {
              this._prioritySampler.update(parsed.rate_by_service)
            }
          } catch (e) {
            log.debug('Could not parse agent response for rate_by_service: %s', e.message)
          }
        }
        done()
      })
      .catch(err => {
        log.errorWithoutTelemetry('Wasm exporter error: %s', err.message, err)
        done()
      })
  }
}

module.exports = WasmWriter
