'use strict'

const http = require('http')
const https = require('https')
const { dockerId, storage } = require('../../../../packages/datadog-core')
const tracerVersion = require('../../../../package.json').version

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 1 })
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 1 })

const DD_TRACE_AGENT_URL = process.env.DD_TRACE_AGENT_URL || process.env.DD_TRACE_URL

class Client {
  request (options, done) {
    if (options.count === 0) return

    const port = options.port || 8127
    const url = new URL(DD_TRACE_AGENT_URL || `http://127.0.0.1:${port}`)
    const isSecure = url.protocol === 'https:'
    const isUnix = url.protocol === 'unix:'
    const client = isSecure ? https : http
    const agent = isSecure ? httpsAgent : httpAgent
    const data = options.data
    const timeout = 2000
    const httpOptions = {
      agent,
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      socketPath: isUnix && url.pathname,
      path: options.path,
      method: 'PUT',
      headers: {
        'Content-Length': String(data.length),
        'Content-Type': 'application/msgpack',
        'Datadog-Container-ID': dockerId || '',
        'Datadog-Meta-Lang': 'nodejs',
        'Datadog-Meta-Lang-Version': process.version,
        'Datadog-Meta-Lang-Interpreter': process.jsEngine || 'v8',
        'Datadog-Meta-Tracer-Version': tracerVersion
      },
      timeout
    }

    const onResponse = res => {
      let data = ''

      res.setTimeout(timeout)
      res.on('data', chunk => {
        data += chunk
      })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode <= 299) {
          try {
            const response = data
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
      const store = storage.getStore()

      storage.enterWith({ noop: true })

      const req = client.request(httpOptions, onResponse)

      req.on('error', onError)

      req.setTimeout(timeout, req.abort)
      req.write(data)
      req.end()

      storage.enterWith(store)
    }

    makeRequest(() => makeRequest(done)) // retry once on error
  }
}

module.exports = { Client }
