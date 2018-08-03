'use strict'

require('../..').init()

const test = require('tape')
const profile = require('../profile')

test('ScopeManager should destroy executions even if their context is already destroyed', t => {
  profile(t, operation)

  function operation (done) {
    Promise.resolve().then(done)
  }
})
