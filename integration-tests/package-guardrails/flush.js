'use strict'

// Remove only the register.js beforeExit handler so this test verifies
// that abort.integration comes from the first flush diagnostic channel.
const beforeExitHandlers = globalThis[Symbol.for('dd-trace')].beforeExitHandlers
for (const handler of beforeExitHandlers) {
  if (handler.name === 'logAbortedIntegrations') {
    beforeExitHandlers.delete(handler)
  }
}

const tracer = require('dd-trace')
const P = require('bluebird')

const isWrapped = P.prototype._then.toString().includes('AsyncResource')
tracer.trace('first.flush.guardrails', () => {})

// eslint-disable-next-line no-console
console.log(isWrapped)
