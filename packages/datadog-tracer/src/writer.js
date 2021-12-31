'use strict'

const { channel } = require('diagnostics_channel')
const http = require('http')
const { Encoder } = require('./encoder')
const { dockerId } = require('../../datadog-core')
const tracerVersion = require('../../dd-trace/lib/version') // TODO: use package.json

const requestChannel = channel('datadog:apm:agent:request')
const responseChannel = channel('datadog:apm:agent:response')
const errorChannel = channel('datadog:apm:agent:error')

const noop = () => {}

class Writer {
  constructor (config) {
    this._config = config
    this._encoder = new Encoder(this, config)
  }

  write (spans) {
    this._encoder.encode(spans)
  }

  flush (done = noop) {
    const count = this._encoder.count()

    if (count === 0) return

    const data = this._encoder.makePayload()
    const timeout = 2000
    const options = {
      hostname: this._config.url.hostname,
      port: this._config.url.port,
      path: '/v0.5/traces',
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
  }
}

module.exports = { Writer }
