'use strict'

require('tap').mochaGlobals()
require('../setup/core')

const apiCompatibilityChecks = require('../../../../vendor/dist/opentracing/lib/test/api_compatibility').default
const tracer = require('../..')

apiCompatibilityChecks(() => {
  return tracer.init({
    service: 'test',
    flushInterval: 0,
    plugins: false
  })
})
