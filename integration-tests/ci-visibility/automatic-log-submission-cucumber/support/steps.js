'use strict'

const assert = require('node:assert/strict')

const { When, Then } = require('@cucumber/cucumber')

const logger = require('./logger')
const sum = require('./sum')
Then('I should have made a log', async function () {
  assert.strictEqual(true, true)
  assert.strictEqual(sum(1, 2), 3)
})

When('we run a test', async function () {
  logger.log('info', 'Hello simple log!')
})
