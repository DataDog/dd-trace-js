'use strict'

/* eslint-disable n/no-unsupported-features/node-builtins */

const { test } = require('node:test')

test('reports before worker suite finishes', () => {})

test('keeps worker alive after the first result', async () => {
  await new Promise(resolve => setTimeout(resolve, 8_000))
})
