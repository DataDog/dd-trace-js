'use strict'

const { test, expect } = require('@playwright/test')
const logger = require('./logger')
const sum = require('./sum')

test.describe('playwright', () => {
  test('should be able to log to the console', () => {
    logger.info('Hello simple log!')

    expect(sum(1, 2)).toEqual(3)
  })
})
