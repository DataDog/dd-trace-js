'use strict'

const assert = require('node:assert/strict')
const { noAutoRetry } = require('dd-trace/test-optimization')
const recordExecution = require('./exclusions-execution-ledger')

describe('WebdriverIO passing exclusions', () => {
  it('excluded', noAutoRetry(() => { recordExecution(); assert.ok(true) }))
  it('control', () => { recordExecution(); assert.ok(true) })
})
