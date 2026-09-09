'use strict'

const loggerName = process.env.TEST_LOGGER
let logger
if (loggerName === 'pino') {
  const createPino = require('pino')
  logger = createPino()
} else {
  logger = require('bunyan').createLogger({ name: 'test-logger' })
}

describe(`${loggerName} real logger test`, () => {
  it('uses the real logger after another suite mocks it', () => {
    logger.info('real logger after mock')
  })
})
