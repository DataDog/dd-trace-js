'use strict'

const assert = require('node:assert/strict')
const { after, before, describe, it } = require('mocha')
const proxyquire = require('proxyquire')

const { NODE_MAJOR } = require('../../../../version')

describe('guard', () => {
  let originalInjectionEnabled

  before(() => {
    originalInjectionEnabled = process.env.DD_INJECTION_ENABLED
    delete process.env.DD_INJECTION_ENABLED
  })

  after(() => {
    if (originalInjectionEnabled !== undefined) {
      process.env.DD_INJECTION_ENABLED = originalInjectionEnabled
    }
  })

  it('should abort when node version exceeds nodeMaxMajor', () => {
    const guard = proxyquire('../../src/guardrails/index', {
      '../../../../package.json': {
        engines: { node: `>=${NODE_MAJOR}` },
        nodeMaxMajor: NODE_MAJOR,
      },
      './log': { info: () => {} },
      './telemetry': () => {},
    })

    let called = false
    const result = guard(() => { called = true })
    assert.strictEqual(called, false)
    assert.strictEqual(result, undefined)
  })
})
