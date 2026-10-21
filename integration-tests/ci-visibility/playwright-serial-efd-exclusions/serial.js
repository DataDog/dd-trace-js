'use strict'

const assert = require('node:assert/strict')

const { test } = require('@playwright/test')
const { noAutoRetry } = require('dd-trace/test-optimization')

let initialized = false

test.describe('serial EFD group', () => {
  test.describe.configure({ mode: 'serial' })
  test('excluded prerequisite', noAutoRetry(() => { initialized = true }))
  test('dependent sibling', () => { assert.strictEqual(initialized, true) })
})
test('independent EFD control', () => {})
