'use strict'

const { channel } = require('diagnostics_channel')
const http = require('http')
const { dockerId } = require('../../datadog-core')
const tracerVersion = require('../../dd-trace/lib/version') // TODO: use package.json

const requestChannel = channel('datadog:apm:agent:request')
const responseChannel = channel('datadog:apm:agent:response')
const errorChannel = channel('datadog:apm:agent:error')

const noop = () => {}

class Writer {
  constructor (config) {
    this._config = config
    this._protocolVersion = config.protocolVersion
    this._encoders = {}
  }

  write (spans) {
    this._getEncoder().encode(spans)
  }

  flush (done = noop) {
    const encoder = this._getEncoder()
    const count = encoder.count()

    if (count === 0) return

    const data = encoder.makePayload()
    const timeout = 2000
    const options = {
      hostname: this._config.url.hostname,
      port: this._config.url.port,
      path: `/v${this._protocolVersion}/traces`,
      method: 'PUT',
      headers: {
        'Content-Length': String(data.length),
        'Content-Type': 'application/msgpack',
        'Datadog-Container-ID': dockerId || '',
        'Datadog-Meta-Lang': 'nodejs',
        'Datadog-Meta-Lang-Version': process.version,
        'Datadog-Meta-Lang-Interpreter': process.jsEngine || 'v8',
        'Datadog-Meta-Tracer-Version': tracerVersion,
        'X-Datadog-Trace-Count': String(count)
      },
      timeout
    }

    requestChannel.publish(data)

    const req = http.request(options, res => {
      let json = ''

      res.setTimeout(timeout)
      res.on('data', chunk => {
        json += chunk
      })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode <= 299) {
          try {
            const response = JSON.stringify(json)
            responseChannel.publish(response)
            done(null, response)
          } catch (e) {
            errorChannel.publish(e)
            done(e)
          }
        } else {
          const statusCode = res.statusCode
          const statusText = http.STATUS_CODES[res.statusCode]
          const error = new Error(`Error from the agent: ${statusCode} ${statusText}`)

          error.status = statusCode
          errorChannel.publish(error)
          done(error, null)
        }
      })
    })

    req.on('error', err => {
      errorChannel.publish(err)
      done(err)
    })

    req.setTimeout(timeout, req.abort)
    req.write(data)

    this._protocolVersion = this._config.protocolVersion
  }

  _getEncoder () {
    const config = this._config
    const protocolVersion = this._protocolVersion

    if (!this._encoders[protocolVersion]) {
      switch (protocolVersion) {
        case '0.5': {
          const { Encoder } = require('./encoder/0.5')
          this._encoders[protocolVersion] = new Encoder(this, config)
          break
        }
        default: {
          const { Encoder } = require('./encoder/0.4')
          this._encoders[protocolVersion] = new Encoder(this, config)
        }
      }
    }

    return this._encoders[protocolVersion]
  }
}

module.exports = { Writer }
