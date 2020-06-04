'use strict'

const axios = require('axios')
const FormData = require('form-data')
const { URL } = require('url')
const { Encoder } = require('../encoders/pprof')
const platform = require('../../platform')

class AgentExporter {
  constructor ({ url, hostname, port } = {}) {
    url = new URL(url || `http://${hostname || 'localhost'}:${port || 8126}`)

    this._client = axios.create({
      baseURL: `${url}profiling/v1/`,
      timeout: 10 * 1000,
      validateStatus: code => code < 400
    })

    this._encoder = new Encoder()
  }

  async export ({ profiles, start, end, tags }) {
    const form = new FormData()
    const types = Object.keys(profiles)
    const runtime = platform.name()

    form.append('recording-start', start.toISOString())
    form.append('recording-end', end.toISOString())
    form.append('language', 'javascript')
    form.append('runtime', runtime)
    form.append('format', 'pprof')

    form.append('tags[]', 'language:javascript')
    form.append('tags[]', `runtime:${runtime}`)
    form.append('tags[]', 'format:pprof')

    for (const key in tags) {
      form.append('tags[]', `${key}:${tags[key]}`)
    }

    for (let i = 0; i < types.length; i++) {
      const type = types[i]
      const profile = profiles[type]
      const buffer = await this._encoder.encode(profile)

      form.append(`types[${i}]`, type)
      form.append(`data[${i}]`, buffer, {
        filename: `${type}.pb.gz`,
        contentType: 'application/octet-stream',
        knownLength: buffer.length
      })
    }

    const headers = form.getHeaders()

    return this._client.post('input', form, { headers })
  }
}

module.exports = { AgentExporter }
