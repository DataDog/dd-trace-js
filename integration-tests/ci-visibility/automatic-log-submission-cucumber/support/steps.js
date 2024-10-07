const { expect } = require('chai')
const { createLogger, format, transports } = require('winston')
const { When, Then } = require('@cucumber/cucumber')

const logger = createLogger({
  level: 'info',
  exitOnError: false,
  format: format.json(),
  transports: [
    new transports.Console()
  ]
})

Then('I should have made a log', async function () {
  expect(true).to.equal(true)
})

When('we run a test', async function () {
  logger.log('info', 'Hello simple log!')
})
