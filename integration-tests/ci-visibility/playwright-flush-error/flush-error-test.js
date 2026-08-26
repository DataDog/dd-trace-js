'use strict'

const tracer = require('dd-trace')
const { expect, test } = require('@playwright/test')

test('finishes when trace flushing throws', () => {
  tracer._tracer._exporter.flush = () => {
    throw new Error('test flush failure')
  }

  expect(1 + 2).toBe(3)
})
