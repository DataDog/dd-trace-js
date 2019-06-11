'use strict'

const tracer = require('../..').init()

const test = require('tape')
const profile = require('../profile')

test('Tracer should not keep unfinished spans in memory if they are no longer needed', t => {
  profile(t, operation)

  function operation (done) {
    tracer.startSpan('test')
    done()
  }
})
