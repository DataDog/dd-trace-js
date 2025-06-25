'use strict'

require('../setup/core')

const apiCompatibilityChecks = require('opentracing/lib/test/api_compatibility').default
const tracer = require('../..')

apiCompatibilityChecks(() => {
  return tracer.init({
    service: 'test',
    flushInterval: 0,
    plugins: false
  })
})
