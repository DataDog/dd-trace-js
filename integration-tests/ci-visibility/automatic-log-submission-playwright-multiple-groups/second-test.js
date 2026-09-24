'use strict'

const { test, expect } = require('@playwright/test')
const logger = require('../automatic-log-submission/logger')

test('second group', async () => {
  logger.info('second group log')
  const response = await fetch(`${process.env.LOG_SUBMISSION_CONTROL_URL}/second-group-started`)
  expect(response.ok).toBe(true)
})
