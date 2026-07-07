'use strict'

// Seed the OTel API holder with the real installed packages, standing in for the
// `@opentelemetry/api` instrumentation that captures the application's copy at require time.
// Bridge modules read the holder at module load, so specs that require the bridge directly
// (without the instrumentation running) must require this first. Using the real packages keeps
// the seam honest: the bridge sees the same module objects it would capture in production.
const holder = require('../../src/opentelemetry/api')

holder.setApi(holder.API, require('@opentelemetry/api'))
holder.setApi(holder.API_LOGS, require('@opentelemetry/api-logs'))

module.exports = holder
