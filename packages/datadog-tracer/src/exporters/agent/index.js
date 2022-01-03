'use strict'

const { Client } = require('./client')
const { EncoderV4 } = require('./encoder/0.4')
const { EncoderV5 } = require('./encoder/0.5')

const noop = () => {}

class AgentExporter {
  constructor (config, sampler) {
    this._config = config
    this._sampler = sampler
    this._protocolVersion = config.protocolVersion
    this._client = new Client(config)
    this._encoder = this._getEncoder()
    this._timer = undefined

    process.once('beforeExit', () => this.flush())
  }

  add (spans) {
    const flushInterval = this._config.flushInterval

    this._encoder.encode(spans)

    if (flushInterval === 0) {
      this.flush()
    } else if (flushInterval > 0 && !this._timer) {
      this._timer = setTimeout(() => this.flush(), flushInterval).unref()
    }
  }

  flush (done = noop) {
    const encoder = this._encoder
    const count = encoder.count()

    if (count === 0) return

    const data = encoder.makePayload()
    const path = `/v${this._protocolVersion}/traces`

    this._client.request({ data, path, count }, (err, res) => {
      if (!err && res.rate_by_service) {
        this._sampler.update(res.rate_by_service)
      }

      done(err)
    })

    this._protocolVersion = this._config.protocolVersion
    this._encoder = this._getEncoder()
  }

  _getEncoder () {
    const config = this._config
    const protocolVersion = this._protocolVersion

    if (this._encoder && protocolVersion === config.protocolVersion) {
      return this._encoder
    }

    switch (protocolVersion) {
      case '0.5': {
        return new EncoderV5(this, config)
      }
      default: {
        return new EncoderV4(this, config)
      }
    }
  }
}

module.exports = { AgentExporter }
