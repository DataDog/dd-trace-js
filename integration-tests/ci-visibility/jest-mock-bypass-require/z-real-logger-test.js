'use strict'

const loggerName = process.env.TEST_LOGGER
const logger = loggerName === 'pino'
  ? require('pino')()
  : require('bunyan').createLogger({ name: 'test-logger' })

describe(`${loggerName} real logger test`, () => {
  it('uses the real logger after another suite mocks it', () => {
    logger.info('real logger after mock')
  })
})
