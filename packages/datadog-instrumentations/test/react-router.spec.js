'use strict'

const assert = require('node:assert/strict')

const {
  injectInstrumentation,
  createDatadogInstrumentation,
  normalizePathname,
  DD_INSTRUMENTATION,
} = require('../src/react-router')

describe('react-router instrumentation helpers', () => {
  it('should normalize .data single-fetch pathnames', () => {
    assert.equal(normalizePathname('/users/1.data'), '/users/1')
    assert.equal(normalizePathname('/.data'), '/')
    assert.equal(normalizePathname('/users'), '/users')
  })

  it('should expose a ServerInstrumentation with handler and route hooks', () => {
    const instrumentation = createDatadogInstrumentation()
    assert.equal(instrumentation[DD_INSTRUMENTATION], true)
    assert.equal(typeof instrumentation.handler, 'function')
    assert.equal(typeof instrumentation.route, 'function')

    let requestHook
    instrumentation.handler({
      instrument (hooks) {
        requestHook = hooks.request
      },
    })
    assert.equal(typeof requestHook, 'function')

    let loaderHook
    instrumentation.route({
      id: 'root',
      instrument (hooks) {
        loaderHook = hooks.loader
      },
    })
    assert.equal(typeof loaderHook, 'function')
  })

  it('should inject instrumentation without mutating the original build', () => {
    const original = {
      entry: {
        module: {
          default () {},
          instrumentations: [{ name: 'user' }],
        },
      },
    }

    const next = injectInstrumentation(original)

    assert.equal(original.entry.module.instrumentations.length, 1)
    assert.equal(next.entry.module.instrumentations.length, 2)
    assert.equal(next.entry.module.instrumentations[0][DD_INSTRUMENTATION], true)
    assert.equal(next.entry.module.instrumentations[1].name, 'user')
  })
})
