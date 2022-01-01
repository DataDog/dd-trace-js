'use strict'

const http = require('http')
const https = require('https')
const { dockerId } = require('../../../../datadog-core')
const tracerVersion = require('../../../../dd-trace/lib/version') // TODO: use package.json

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 1 })
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 1 })

class Client {
  constructor (config) {
    this._config = config
  }

  request (options, done) {
    if (options.count === 0) return

    const isSecure = options.protocol === 'https:'
    const client = isSecure ? https : http
    const agent = isSecure ? httpsAgent : httpAgent
    const data = options.data
    const timeout = 2000
    const httpOptions = {
      agent,
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

    const onResponse = res => {
      let json = ''

      res.setTimeout(timeout)
      res.on('data', chunk => {
        json += chunk
      })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode <= 299) {
          try {
            const response = JSON.parse(json)
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
    }

    const makeRequest = onError => {
      const req = client.request(httpOptions, onResponse)

      req.on('error', onError)

      req.setTimeout(timeout, req.abort)
      req.write(data)
    }

    makeRequest(() => makeRequest(done)) // retry once on error
  }
}

module.exports = { Client }
