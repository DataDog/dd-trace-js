'use strict'

const { test, expect } = require('@playwright/test')
const logger = require('../automatic-log-submission/logger')

test('first group', async () => {
  logger.info('first group log')
  const response = await fetch(`${process.env.LOG_SUBMISSION_CONTROL_URL}/wait-for-first-log`)
  expect(response.ok).toBe(true)
})
