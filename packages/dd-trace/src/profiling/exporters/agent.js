'use strict'

const { request } = require('http')
const FormData = require('form-data')

function wait (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function * times (base, timeout) {
  let attempt = 0
  let n

  // base * n is the current stride length
  // base * (n - 1) is the sum prior steps
  // therefore, base * n + base * (n - 1) is the final total
  while (timeout > base * ((n = 2 ** attempt++) - 1) + base * n) {
    yield base * n * Math.random()
  }
}

async function backoff (base, overallTimeout, task) {
  for (const timeout of times(base, overallTimeout)) {
    const start = Date.now()
    if (await task(timeout)) return
    const remaining = timeout - (Date.now() - start)
    if (remaining > 0) await wait(remaining)
  }

  throw new Error('Profiler agent export back-off period expired without send')
}

function sendRequest (options, body) {
  return new Promise((resolve, reject) => {
    const req = request(options, resolve)
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function getBody (stream, callback) {
  const chunks = []
  stream.on('error', callback)
  stream.on('data', chunk => chunks.push(chunk))
  stream.on('end', () => {
    callback(null, Buffer.concat(chunks))
  })
}

class AgentExporter {
  constructor ({ url, logger, uploadTimeout, backoffBase } = {}) {
    this._url = url
    this._logger = logger
    this._uploadTimeout = uploadTimeout || 60 * 1000
    this._backoffBase = backoffBase || 1000
  }

  export ({ profiles, start, end, tags }) {
    const form = new FormData()
    const types = Object.keys(profiles)

    const fields = [
      ['recording-start', start.toISOString()],
      ['recording-end', end.toISOString()],
      ['language', 'javascript'],
      ['runtime', 'nodejs'],
      ['format', 'pprof'],

      ['tags[]', 'language:javascript'],
      ['tags[]', 'runtime:nodejs'],
      ['tags[]', 'format:pprof'],
      ...Object.entries(tags).map(([key, value]) => ['tags[]', `${key}:${value}`])
    ]

    for (const [key, value] of fields) {
      form.append(key, value)
    }

    this._logger.debug(() => {
      const body = fields.map(([key, value]) => `  ${key}: ${value}`).join('\n')
      return `Building agent export report: ${'\n' + body}`
    })

    for (let index = 0; index < types.length; index++) {
      const type = types[index]
      const buffer = profiles[type]

      this._logger.debug(() => {
        const bytes = buffer.toString('hex').match(/../g).join(' ')
        return `Adding ${type} profile to agent export: ` + bytes
      })

      form.append(`types[${index}]`, type)
      form.append(`data[${index}]`, buffer, {
        filename: `${type}.pb.gz`,
        contentType: 'application/octet-stream',
        knownLength: buffer.length
      })
    }

    const body = form.getBuffer()
    const options = {
      method: 'POST',
      path: '/profiling/v1/input',
      headers: form.getHeaders()
    }

    if (this._url.protocol === 'unix:') {
      options.socketPath = this._url.pathname
    } else {
      options.protocol = this._url.protocol
      options.hostname = this._url.hostname
      options.port = this._url.port
    }

    this._logger.debug(() => {
      return `Submitting agent report to: ${JSON.stringify(options)}`
    })

    return backoff(this._backoffBase, this._uploadTimeout, async (timeout) => {
      let response
      try {
        response = await sendRequest({ ...options, timeout }, body)
      } catch (err) {
        this._logger.debug(err.stack)
      }
      if (!response) return false

      const { statusCode } = response
      if (statusCode >= 400) {
        this._logger.debug(`Error from the agent: ${statusCode}`)
      }

      getBody(response, (err, body) => {
        if (err) {
          this._logger.debug(`Error reading agent response: ${err.message}`)
        } else {
          this._logger.debug(() => {
            const bytes = body.toString('hex').match(/../g).join(' ')
            return `Agent export response: ${bytes}`
          })
        }
      })

      return statusCode < 500
    })
  }
}

module.exports = { AgentExporter }
