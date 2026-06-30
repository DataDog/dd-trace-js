'use strict'

const { DogStatsDClient } = require('../../dd-trace/src/dogstatsd')
const NoopDogStatsDClient = require('../../dd-trace/src/noop/dogstatsd')
const { ExternalLogger, NoopExternalLogger } = require('../../dd-trace/src/external-logger/src')

const FLUSH_INTERVAL = 10 * 1000

let metrics = null
let logger = null
let interval = null

module.exports.init = function (tracerConfig) {
  metrics = tracerConfig && tracerConfig.dogstatsd
    ? new DogStatsDClient({
      host: tracerConfig.dogstatsd.hostname,
      port: tracerConfig.dogstatsd.port,
      tags: [
        `service:${tracerConfig.tags.service}`,
        `env:${tracerConfig.tags.env}`,
        `version:${tracerConfig.tags.version}`,
      ],
      lookup: tracerConfig.lookup,
    })
    : new NoopDogStatsDClient()

  logger = tracerConfig && tracerConfig.DD_API_KEY
    ? new ExternalLogger({
      ddsource: 'openai',
      hostname: tracerConfig.hostname,
      service: tracerConfig.service,
      apiKey: tracerConfig.DD_API_KEY,
      interval: FLUSH_INTERVAL,
    })
    : new NoopExternalLogger()

  interval = setInterval(() => {
    metrics.flush()
  }, FLUSH_INTERVAL)
  interval.unref?.()

  return { metrics, logger }
}

module.exports.shutdown = function () {
  clearInterval(interval)
  metrics = null
  logger = null
  interval = null
}
