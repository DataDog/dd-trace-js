'use strict'

const { inspect } = require('node:util')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')

describe('DebugLoggingHook', () => {
  let DebugLoggingHook
  let log

  beforeEach(() => {
    log = {
      debug: sinon.spy(),
      warn: sinon.spy(),
    }

    DebugLoggingHook = proxyquire('../../src/openfeature/debug-logging-hook', {
      '../log': log,
    })
  })

  it('logs the flag key and evaluation details on finally', () => {
    const hook = new DebugLoggingHook()
    const evaluationDetails = { value: true, reason: 'STATIC' }

    hook.finally({ flagKey: 'my-flag' }, evaluationDetails)

    sinon.assert.calledOnceWithExactly(
      log.debug,
      'Feature Flags: evaluated %s: %o',
      'my-flag',
      evaluationDetails
    )
    sinon.assert.notCalled(log.warn)
  })

  it('tolerates a missing hookContext', () => {
    const hook = new DebugLoggingHook()

    hook.finally(undefined, { value: false })

    sinon.assert.calledOnceWithExactly(
      log.debug,
      'Feature Flags: evaluated %s: %o',
      undefined,
      { value: false }
    )
  })

  it('contains a throwing custom inspect method instead of letting it escape finally()', () => {
    const hook = new DebugLoggingHook()
    const evilDetails = {
      value: true,
      [inspect.custom] () {
        throw new Error('boom: custom inspect exploded')
      },
    }
    log.debug = sinon.stub().callsFake((...args) => {
      // Mirrors the real logger: %o formatting only happens once a subscriber
      // actually consumes the arguments, i.e. inside this fake, like the real thing.
      require('node:util').format(...args)
    })

    hook.finally({ flagKey: 'evil-flag' }, evilDetails)

    sinon.assert.calledOnceWithMatch(log.warn, 'DebugLoggingHook: error in finally hook: %s', sinon.match.string)
  })
})
