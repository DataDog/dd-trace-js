'use strict'

const tracer = require('../..').init()

const test = require('tape')
const profile = require('../profile')

test('ScopeManager should destroy executions even if their context is already destroyed', t => {
  profile(t, operation)

  function operation (done) {
    Promise.resolve().then(done)
  }
})

test('ScopeManager should not leak when using scopes with recursive timers', t => {
  profile(t, operation)

  function operation (done) {
    const active = tracer.scopeManager().active()

    active && active.close()

    tracer.scopeManager().activate({})

    done()
  }
})
