'use strict'

const retry = require('retry')
const { Blob } = require('buffer')
const { Client, FormData } = require('undici')

// TODO: avoid using dd-trace internals. Make this a separate module?
const docker = require('../../exporters/common/docker')
const version = require('../../../../../package.json').version

const containerId = docker.id()

function sendRequest (client, options, callback) {
  client.request(options).then((res) => {
    if (res.statusCode >= 400) {
      const error = new Error(`HTTP Error ${res.statusCode}`)
      error.status = res.statusCode
      setImmediate(callback, error)
    } else {
      setImmediate(callback, null, res.body)
    }
  }, err => {
    setImmediate(callback, err)
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

    this._client = url.protocol === 'unix:'
      ? new Client({ ...url, protocol: 'http:' }, { socketPath: url.pathname })
      : new Client(url)
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
      fields.push([`data[${index}]`, new Blob([buffer]), `${type}.pb.gz`])
    }

    return new Promise((resolve, reject) => {
      const operation = retry.operation({
        randomize: true,
        minTimeout: this._backoffTime,
        retries: this._backoffTries
      })

      operation.attempt((attempt) => {
        const form = new FormData()

        for (const field of fields) {
          form.append(...field)
        }

        const options = {
          method: 'POST',
          path: '/profiling/v1/input',
          timeout: this._backoffTime * Math.pow(2, attempt),
          headers: {},
          body: form
        }

        options.signal = AbortSignal.timeout(options.timeout)

        if (containerId) {
          options.headers['Datadog-Container-ID'] = containerId
        }

        this._logger.debug(() => {
          return `Submitting profiler agent report attempt #${attempt} to: ${JSON.stringify(options)}`
        })

        sendRequest(this._client, options, (err, response) => {
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
