'use strict'

const DogStatsDClient = require('../../dd-trace/src/dogstatsd')
const ExternalLogger = require('../../dd-trace/src/external-logger/src')

const FLUSH_INTERVAL = 10 * 1000

let metrics = null
let logger = null
let interval = null

module.exports.init = function (tracerConfig) {
  metrics = new DogStatsDClient({
    host: tracerConfig.dogstatsd.hostname,
    port: tracerConfig.dogstatsd.port,
    tags: [
      `service:${tracerConfig.tags.service}`,
      `env:${tracerConfig.tags.env}`,
      `version:${tracerConfig.tags.version}`
    ]
  })

  logger = new ExternalLogger({
    ddsource: 'openai',
    hostname: tracerConfig.hostname,
    service: tracerConfig.service,
    apiKey: tracerConfig.apiKey,
    interval: FLUSH_INTERVAL
  })

  interval = setInterval(() => {
    metrics.flush()
  }, FLUSH_INTERVAL).unref()

  return { metrics, logger }
}

module.exports.shutdown = function () {
  clearInterval(interval)
  metrics = null
  logger = null
  interval = null
}
