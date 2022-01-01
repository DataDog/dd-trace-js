'use strict'

const http = require('http')
const { dockerId } = require('../../../../datadog-core')
const tracerVersion = require('../../../../dd-trace/lib/version') // TODO: use package.json

class Client {
  constructor (config) {
    this._config = config
  }

  request (options, done) {
    if (options.count === 0) return

    const data = options.data
    const timeout = 2000
    const httpOptions = {
      hostname: this._config.url.hostname,
      port: this._config.url.port,
      path: options.path,
      method: 'PUT',
      headers: {
        'Content-Length': String(data.length),
        'Content-Type': 'application/msgpack',
        'Datadog-Container-ID': dockerId || '',
        'Datadog-Meta-Lang': 'nodejs',
        'Datadog-Meta-Lang-Version': process.version,
        'Datadog-Meta-Lang-Interpreter': process.jsEngine || 'v8',
        'Datadog-Meta-Tracer-Version': tracerVersion,
        'X-Datadog-Trace-Count': String(options.count)
      },
      timeout
    }

    const req = http.request(httpOptions, res => {
      let json = ''

      res.setTimeout(timeout)
      res.on('data', chunk => {
        json += chunk
      })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode <= 299) {
          try {
            const response = JSON.stringify(json)
            done(null, response)
          } catch (e) {
            done(e)
          }
        } else {
          const statusCode = res.statusCode
          const statusText = http.STATUS_CODES[res.statusCode]
          const error = new Error(`Error from the agent: ${statusCode} ${statusText}`)

          error.status = statusCode

          done(error, null)
        }
      })
    })

    req.on('error', err => {
      done(err)
    })

    req.setTimeout(timeout, req.abort)
    req.write(data)
  }
}

module.exports = { Client }
