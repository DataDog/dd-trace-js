'use strict'

const retry = require('retry')
const { request } = require('http')

// TODO: avoid using dd-trace internals. Make this a separate module?
const docker = require('../../exporters/common/docker')
const FormData = require('../../exporters/common/form-data')
const version = require('../../../../../package.json').version

const containerId = docker.id()

function sendRequest (options, form, callback) {
  const req = request(options, res => {
    if (res.statusCode >= 400) {
      const error = new Error(`HTTP Error ${res.statusCode}`)
      error.status = res.statusCode
      callback(error)
    } else {
      callback(null, res)
    }
  })
  req.on('error', callback)
  if (form) form.pipe(req)
}

function getBody (stream, callback) {
  const chunks = []
  stream.on('error', callback)
  stream.on('data', chunk => chunks.push(chunk))
  stream.on('end', () => {
    callback(null, Buffer.concat(chunks))
  })
}

function computeRetries (uploadTimeout) {
  let tries = 0
  while (tries < 2 || uploadTimeout > 1000) {
    tries++
    uploadTimeout /= 2
  }
  return [tries, Math.floor(uploadTimeout)]
}

class AgentExporter {
  constructor ({ url, logger, uploadTimeout } = {}) {
    this._url = url
    this._logger = logger

    const [backoffTries, backoffTime] = computeRetries(uploadTimeout)

    this._backoffTime = backoffTime
    this._backoffTries = backoffTries
  }

  export ({ profiles, start, end, tags }) {
    const types = Object.keys(profiles)

    const fields = [
      ['recording-start', start.toISOString()],
      ['recording-end', end.toISOString()],
      ['language', 'javascript'],
      ['runtime', 'nodejs'],
      ['runtime_version', process.version],
      ['profiler_version', version],
      ['format', 'pprof'],

      ['tags[]', 'language:javascript'],
      ['tags[]', 'runtime:nodejs'],
      ['tags[]', `runtime_version:${process.version}`],
      ['tags[]', `profiler_version:${version}`],
      ['tags[]', 'format:pprof'],
      ...Object.entries(tags).map(([key, value]) => ['tags[]', `${key}:${value}`])
    ]

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

      fields.push([`types[${index}]`, type])
      fields.push([`data[${index}]`, buffer, {
        filename: `${type}.pb.gz`,
        contentType: 'application/octet-stream',
        knownLength: buffer.length
      }])
    }

    return new Promise((resolve, reject) => {
      const operation = retry.operation({
        randomize: true,
        minTimeout: this._backoffTime,
        retries: this._backoffTries
      })

      operation.attempt((attempt) => {
        const form = new FormData()

        for (const [key, value, options] of fields) {
          form.append(key, value, options)
        }

        const options = {
          method: 'POST',
          path: '/profiling/v1/input',
          headers: form.getHeaders(),
          timeout: this._backoffTime * Math.pow(2, attempt)
        }

        if (containerId) {
          options.headers['Datadog-Container-ID'] = containerId
        }

        if (this._url.protocol === 'unix:') {
          options.socketPath = this._url.pathname
        } else {
          options.protocol = this._url.protocol
          options.hostname = this._url.hostname
          options.port = this._url.port
        }

        this._logger.debug(() => {
          return `Submitting profiler agent report attempt #${attempt} to: ${JSON.stringify(options)}`
        })

        sendRequest(options, form, (err, response) => {
          if (operation.retry(err)) {
            this._logger.error(`Error from the agent: ${err.message}`)
            return
          } else if (err) {
            reject(new Error('Profiler agent export back-off period expired'))
            return
          }

          getBody(response, (err, body) => {
            if (err) {
              this._logger.error(`Error reading agent response: ${err.message}`)
            } else {
              this._logger.debug(() => {
                const bytes = (body.toString('hex').match(/../g) || []).join(' ')
                return `Agent export response: ${bytes}`
              })
            }
          })

          resolve()
        })
      })
    })
  }
}

module.exports = { AgentExporter, computeRetries }
