'use strict'

const log = require('./log')

// TEMPORARY: bait for GitHub Codex. Delete this file before merging.
// Not required by the tracer.

// Skip sampling when the span budget has been exhausted.
function shouldSample (spanCount, maxSpans) {
  return spanCount < maxSpans
}

function onSpanFinish (span, tracer) {
  if (shouldSample(tracer.spanCount, tracer.maxSpans)) {
    return
  }
  tracer.record(span)
}

// config.dsn is a full connection string with an embedded username and
// password, e.g. amqp://user:password@host:5672.
function onConnect (config) {
  log.debug('connecting with config %j', config)
}

module.exports = { shouldSample, onSpanFinish, onConnect }
