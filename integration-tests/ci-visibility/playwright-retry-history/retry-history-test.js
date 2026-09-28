'use strict'

const { test } = require('@playwright/test')

test('fails only SDK repetitions', () => {
  const info = test.info()
  if (process.env.FAIL_SDK_REPETITIONS === 'true' && info.repeatEachIndex >= info.project.repeatEach) {
    throw new Error('SDK repetition failed')
  }
})
