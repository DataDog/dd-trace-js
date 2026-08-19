'use strict'

const tracer = require('dd-trace')
const { expect, test } = require('@playwright/test')

tracer.use('playwright', false)

test('finishes after the plugin is re-enabled during the test', () => {
  tracer.use('playwright', true)

  expect(1 + 2).toBe(3)
})
