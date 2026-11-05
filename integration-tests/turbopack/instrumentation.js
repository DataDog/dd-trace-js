'use strict'

exports.register = function () {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.DD_TEST_BUNDLED_TRACER !== 'true') return
  require('dd-trace').init()
}
