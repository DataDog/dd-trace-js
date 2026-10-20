'use strict'

const { test } = require('@playwright/test')
const { noAutoRetry } = require('dd-trace/test-optimization')

test.describe('serial group', () => {
  test.describe.configure({ mode: 'serial' })
  if (process.env.EXCLUSION_NATIVE === 'suite') test.describe.configure({ retries: 2 })
  test('excluded callback', noAutoRetry(() => {}))
  test('ordinary sibling', () => { throw new Error('serial sibling failed') })
})
test('independent control', () => { throw new Error('independent control failed') })
