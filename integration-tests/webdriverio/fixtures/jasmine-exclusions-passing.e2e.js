'use strict'

const assert = require('node:assert/strict')
const { noAutoRetry } = require('dd-trace/test-optimization')

describe('WebdriverIO passing exclusions', () => {
  it('excluded', noAutoRetry(() => assert.ok(true)))
  it('control', () => assert.ok(true))
})
