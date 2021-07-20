'use strict'

const coalesce = require('koalas')
const FormData = require('form-data')
const { URL } = require('url')

const {
  DD_TRACE_AGENT_URL,
  DD_AGENT_HOST,
  DD_TRACE_AGENT_PORT
} = process.env

class AgentExporter {
  constructor (options = {}) {
    const hostname = coalesce(options.hostname, DD_AGENT_HOST, 'localhost')
    const port = coalesce(options.port, DD_TRACE_AGENT_PORT, 8126)
    const url = new URL(coalesce(options.url, DD_TRACE_AGENT_URL,
      `http://${hostname || 'localhost'}:${port || 8126}`))

    this._url = url
    this._logger = options.logger
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

    return new Promise((resolve, reject) => {
      const options = {
        method: 'POST',
        path: '/profiling/v1/input',
        timeout: 10 * 1000
      }

      if (this._url.protocol === 'unix:') {
        options.socketPath = this._url.pathname
      } else {
        options.protocol = this._url.protocol
        options.hostname = this._url.hostname
        options.port = this._url.port
      }

      this._logger.debug(`Submitting agent report to: ${JSON.stringify(options)}`)

      form.submit(options, (err, res) => {
        if (err || !res) return reject(err)

        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          this._logger.debug(`Agent export response: ${Buffer.concat(chunks)}`)
        })

        if (res.statusCode >= 400) {
          return reject(new Error(`Error from the agent: ${res.statusCode}`))
        }

        resolve()
      })
    })
  }
}

module.exports = { AgentExporter }
