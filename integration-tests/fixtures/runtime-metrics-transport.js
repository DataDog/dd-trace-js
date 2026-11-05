'use strict'

require('../..').init({ runtimeMetrics: { enabled: true, native: false }, plugins: false })

const { metrics } = require('@opentelemetry/api')

metrics.getMeter('application').createCounter('application.requests').add(7)

process.once('message', () => {
  metrics.getMeterProvider().shutdown(error => {
    if (error) process.stderr.write(String(error))
    process.exit(error ? 1 : 0)
  })
})
