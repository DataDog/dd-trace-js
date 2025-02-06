'use strict'

const { expect } = require('chai')
const { When, Then } = require('@cucumber/cucumber')

const logger = require('./logger')
const sum = require('./sum')

Then('I should have made a log', async function () {
  expect(true).to.equal(true)
  expect(sum(1, 2)).to.equal(3)
})

When('we run a test', async function () {
  logger.log('info', 'Hello simple log!')
})
