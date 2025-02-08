'use strict'

const { tracerConfigure } = require('./channels')
const RateLimiter = require('../rate_limiter')

let actorsEnabled = 0

function configure ({ apmTracingEnabled }) {
  if (apmTracingEnabled === false) {
    if (actorsEnabled === 0) {
      tracerConfigure.subscribe(onTracerConfigure)
    }
    actorsEnabled++
  } else {
    disable(true)
  }
}

function onTracerConfigure ({ tracer }) {
  if (tracer?._prioritySampler) {
    tracer._prioritySampler._limiter = new RateLimiter(1, 'minute')
  }
}

function disable (force = false) {
  if (!tracerConfigure.hasSubscribers) return

  if (force) {
    actorsEnabled = 0
  } else if (actorsEnabled > 0) {
    actorsEnabled--
  }

  if (actorsEnabled === 0) tracerConfigure.unsubscribe(onTracerConfigure)
}

module.exports = {
  configure,
  disable
}
