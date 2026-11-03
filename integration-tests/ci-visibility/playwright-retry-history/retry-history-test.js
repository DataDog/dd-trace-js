'use strict'

const { test } = require('@playwright/test')

test('fails only SDK repetitions', () => {
  const info = test.info()
  // Worker project config does not reflect the CLI --repeat-each override.
  if (info.repeatEachIndex >= Number(process.env.NATIVE_REPEAT_EACH)) {
    throw new Error('SDK repetition failed')
  }
})
