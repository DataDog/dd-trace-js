'use strict'

const { test } = require('@playwright/test')

test.beforeAll(() => {
  throw new Error('independent beforeAll failure')
})

test('should not run after beforeAll fails', () => {})
