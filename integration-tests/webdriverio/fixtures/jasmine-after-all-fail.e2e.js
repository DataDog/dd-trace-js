'use strict'

const tracer = require('dd-trace')

const assert = require('node:assert/strict')

describe('WebdriverIO Jasmine afterAll failure', () => {
  // eslint-disable-next-line no-undef -- Jasmine exposes afterAll through WebdriverIO.
  afterAll(() => {
    throw new Error('expected WebdriverIO Jasmine afterAll failure')
  })

  it('passes before afterAll fails', () => {
    assert.ok(tracer.scope().active())
  })
})
