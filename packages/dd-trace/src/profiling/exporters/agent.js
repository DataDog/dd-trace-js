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
  }

  export ({ profiles, start, end, tags }) {
    const form = new FormData()
    const types = Object.keys(profiles)

    form.append('recording-start', start.toISOString())
    form.append('recording-end', end.toISOString())
    form.append('language', 'javascript')
    form.append('runtime', 'nodejs')
    form.append('format', 'pprof')

    form.append('tags[]', 'language:javascript')
    form.append('tags[]', 'runtime:nodejs')
    form.append('tags[]', 'format:pprof')

    for (const key in tags) {
      form.append('tags[]', `${key}:${tags[key]}`)
    }

    for (let index = 0; index < types.length; index++) {
      const type = types[index]
      const buffer = profiles[type]

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

      form.submit(options, (err, res) => {
        if (err) return reject(err)
        if (res.statusCode >= 400) {
          return reject(new Error(`Error from the agent: ${res.statusCode}`))
        }

        resolve()
      })
    })
  }
}

module.exports = { AgentExporter }
