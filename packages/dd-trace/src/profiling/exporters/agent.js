'use strict'

const retry = require('retry')
const { request: httpRequest } = require('http')
const { request: httpsRequest } = require('https')
const { EventSerializer } = require('./event_serializer')

// TODO: avoid using dd-trace internals. Make this a separate module?
const docker = require('../../exporters/common/docker')
const FormData = require('../../exporters/common/form-data')
const { storage } = require('../../../../datadog-core')
const version = require('../../../../../package.json').version
const { urlToHttpOptions } = require('url')
const perf = require('perf_hooks').performance

const telemetryMetrics = require('../../telemetry/metrics')
const profilersNamespace = telemetryMetrics.manager.namespace('profilers')

const containerId = docker.id()

const statusCodeCounters = []
const requestCounter = profilersNamespace.count('profile_api.requests', [])
const sizeDistribution = profilersNamespace.distribution('profile_api.bytes', [])
const durationDistribution = profilersNamespace.distribution('profile_api.ms', [])
const statusCodeErrorCounter = profilersNamespace.count('profile_api.errors', ['type:status_code'])
const networkErrorCounter = profilersNamespace.count('profile_api.errors', ['type:network'])
// TODO: implement timeout error counter when we have a way to track timeouts
// const timeoutErrorCounter = profilersNamespace.count('profile_api.errors', ['type:timeout'])

function countStatusCode (statusCode) {
  let counter = statusCodeCounters[statusCode]
  if (counter === undefined) {
    counter = statusCodeCounters[statusCode] = profilersNamespace.count(
      'profile_api.responses', [`status_code:${statusCode}`]
    )
  }
  counter.inc()
}

function sendRequest (options, form, callback) {
  const request = options.protocol === 'https:' ? httpsRequest : httpRequest

  const store = storage('legacy').getStore()
  storage('legacy').enterWith({ noop: true })
  requestCounter.inc()
  const start = perf.now()
  const req = request(options, res => {
    durationDistribution.track(perf.now() - start)
    countStatusCode(res.statusCode)
    if (res.statusCode >= 400) {
      statusCodeErrorCounter.inc()
      const error = new Error(`HTTP Error ${res.statusCode}`)
      error.status = res.statusCode
      callback(error)
    } else {
      callback(null, res)
    }
  })

  req.on('error', (err) => {
    networkErrorCounter.inc()
    callback(err)
  })
  if (form) {
    sizeDistribution.track(form.size())
    form.pipe(req)
  }
  storage('legacy').enterWith(store)
}

function getBody (stream, callback) {
  const chunks = []
  stream.on('error', (err) => {
    networkErrorCounter.inc()
    callback(err)
  })
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

class AgentExporter extends EventSerializer {
  constructor (config = {}) {
    super(config)
    const { url, logger, uploadTimeout } = config
    this._url = url
    this._logger = logger

    const [backoffTries, backoffTime] = computeRetries(uploadTimeout)

    this._backoffTime = backoffTime
    this._backoffTries = backoffTries
  }

  export (exportSpec) {
    const { profiles } = exportSpec
    const fields = []

    const event = this.getEventJSON(exportSpec)
    fields.push(['event', event, {
      filename: 'event.json',
      contentType: 'application/json'
    }])

    this._logger.debug(() => {
      return `Building agent export report:\n${event}`
    })

    for (const [type, buffer] of Object.entries(profiles)) {
      this._logger.debug(() => {
        const bytes = buffer.toString('hex').match(/../g).join(' ')
        return `Adding ${type} profile to agent export: ` + bytes
      })

      const filename = this.typeToFile(type)
      fields.push([filename, buffer, {
        filename,
        contentType: 'application/octet-stream'
      }])
    }

    return new Promise((resolve, reject) => {
      const operation = retry.operation({
        randomize: true,
        minTimeout: this._backoffTime,
        retries: this._backoffTries,
        unref: true
      })

      operation.attempt((attempt) => {
        const form = new FormData()

        for (const [key, value, options] of fields) {
          form.append(key, value, options)
        }

        const options = {
          method: 'POST',
          path: '/profiling/v1/input',
          headers: {
            'DD-EVP-ORIGIN': 'dd-trace-js',
            'DD-EVP-ORIGIN-VERSION': version,
            ...form.getHeaders()
          },
          timeout: this._backoffTime * Math.pow(2, attempt)
        }

        if (containerId) {
          options.headers['Datadog-Container-ID'] = containerId
        }

        if (this._url.protocol === 'unix:') {
          options.socketPath = this._url.pathname
        } else {
          const httpOptions = urlToHttpOptions(this._url)
          options.protocol = httpOptions.protocol
          options.hostname = httpOptions.hostname
          options.port = httpOptions.port
        }

        this._logger.debug(() => {
          return `Submitting profiler agent report attempt #${attempt} to: ${JSON.stringify(options)}`
        })

        sendRequest(options, form, (err, response) => {
          if (err) {
            const { status } = err
            if ((typeof status !== 'number' || status >= 500 || status === 429) && operation.retry(err)) {
              this._logger.warn(`Error from the agent: ${err.message}`)
            } else {
              reject(err)
            }
            return
          }

          getBody(response, (err, body) => {
            if (err) {
              this._logger.warn(`Error reading agent response: ${err.message}`)
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
