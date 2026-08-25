'use strict'

const { test } = require('@playwright/test')
const logger = require('../automatic-log-submission/logger')

test('second group', () => {
  logger.info('second group log')
})
