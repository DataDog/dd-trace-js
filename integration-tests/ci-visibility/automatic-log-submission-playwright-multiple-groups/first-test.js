'use strict'

const { test } = require('@playwright/test')
const logger = require('../automatic-log-submission/logger')

test('first group', () => {
  logger.info('first group log')
})
