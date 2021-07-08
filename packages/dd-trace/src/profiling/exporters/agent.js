'use strict'

const FormData = require('form-data')
const { URL } = require('url')
const { Encoder } = require('../encoders/pprof')
const { eachOfSeries } = require('../util')

class AgentExporter {
  constructor ({ url } = {}) {
    this._url = typeof url === 'string' ? new URL(url) : url
    this._encoder = new Encoder()
  }

  export ({ profiles, start, end, tags }, callback) {
    const form = new FormData()
    const types = Object.keys(profiles)

    form.append('recording-start', start.toISOString())
    form.append('recording-end', end.toISOString())
    form.append('language', 'javascript')
    form.append('runtime', 'nodejs')
    form.append('format', 'pprof')

    form.append('tags[]', 'language:javascript')
    form.append('tags[]', `runtime:nodejs`)
    form.append('tags[]', 'format:pprof')

    for (const key in tags) {
      form.append('tags[]', `${key}:${tags[key]}`)
    }

    eachOfSeries(types, (type, index, callback) => {
      const profile = profiles[type]

      this._encoder.encode(profile, (err, buffer) => {
        if (err) return callback(err)

        form.append(`types[${index}]`, type)
        form.append(`data[${index}]`, buffer, {
          filename: `${type}.pb.gz`,
          contentType: 'application/octet-stream',
          knownLength: buffer.length
        })

        callback(null, buffer)
      })
    }, err => {
      if (err) return callback(err)

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
        if (err) return callback(err)
        if (res.statusCode >= 400) {
          return callback(new Error(`Error from the agent: ${res.statusCode}`))
        }

        callback()
      })
    })
  }
}

module.exports = { AgentExporter }
