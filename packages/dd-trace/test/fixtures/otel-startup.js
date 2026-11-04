'use strict'

/* eslint-disable no-console, n/no-process-exit */

const lines = []
console.warn = line => lines.push(line)
const options = {
  appsec: false,
  iast: false,
  plugins: false,
  remoteConfig: { enabled: false },
  runtimeMetrics: false,
  startupLogs: true,
  ...JSON.parse(process.argv[2] ?? '{}'),
}
const errors = []
let serializationCalls = 0
if (process.env.OTEL_STARTUP_UNSAFE_TAG) {
  options.tags = { custom: { toJSON () { serializationCalls++; throw new Error('unsafe-tag') } } }
  options.logger = { error: error => errors.push(String(error)), warn () {}, info () {}, debug () {} }
}
let previousProvider
let getProvider
if (process.env.OTEL_STARTUP_EXISTING_PROVIDER === 'metrics') {
  const { metrics: metricsApi, createNoopMeter } = require('@opentelemetry/api')
  previousProvider = { getMeter: () => createNoopMeter() }
  metricsApi.setGlobalMeterProvider(previousProvider)
  getProvider = () => metricsApi.getMeterProvider()
} else if (process.env.OTEL_STARTUP_EXISTING_PROVIDER === 'logs') {
  const { logs: logsApi } = require('@opentelemetry/api-logs')
  previousProvider = { getLogger: () => ({ emit () {} }) }
  logsApi.setGlobalLoggerProvider(previousProvider)
  getProvider = () => logsApi.getLoggerProvider()
}
const tracer = require('../../../../').init(options)
const { tracerInfo } = require('../../src/startup-log')
const startupLines = lines.filter(line => line.startsWith('DATADOG TRACER CONFIGURATION - '))
const configuration = startupLines.length ? JSON.parse(startupLines[0].split(' - ')[1]) : undefined

tracer.init(options)
if (process.env.OTEL_STARTUP_MUTATE) {
  const getConfig = require('../../src/config')
  const config = getConfig()
  config.service = 'changed-service'
  config.tags.changed = 'changed'
  if (Array.isArray(config.tags.mutable)) config.tags.mutable.push('changed')
  config.OTEL_EXPORTER_OTLP_LOGS_HEADERS = { authorization: 'changed-secret' }
}

let carrier
if (process.env.OTEL_STARTUP_SAMPLE) {
  const span = tracer.startSpan('startup-sampling-test')
  carrier = {}
  tracer.inject(span, 'text_map', carrier)
}

process.stdout.write('STARTUP_RESULT ' + JSON.stringify({
  configuration,
  carrier,
  flare: process.env.OTEL_STARTUP_UNSAFE_TAG ? undefined : JSON.parse(String(tracerInfo())),
  previousProviderStillActive: getProvider && getProvider() === previousProvider,
  serializationCalls,
  errors,
  lines,
}) + '\n')

if (process.env.OTEL_STARTUP_EMIT) {
  const { logs } = require('@opentelemetry/api-logs')
  const { metrics } = require('@opentelemetry/api')
  logs.getLogger('startup-test').emit({ body: 'startup-test' })
  metrics.getMeter('startup-test').createCounter('startup_test_counter').add(1)
  tracer.trace('startup-test', () => {})
  process.on('message', () => process.exit(0))
} else {
  process.exit(0)
}
