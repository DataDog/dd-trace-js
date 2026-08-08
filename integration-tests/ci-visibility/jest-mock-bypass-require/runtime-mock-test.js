'use strict'

const loggerName = process.env.TEST_LOGGER
const mockMethod = process.env.TEST_MOCK_METHOD
const logger = { info: jest.fn() }
const createLogger = jest.fn(() => logger)
const mockedModule = loggerName === 'pino' ? createLogger : { createLogger }

if (mockMethod === 'doMock') {
  jest.doMock(loggerName, () => mockedModule)
} else {
  jest.setMock(loggerName, mockedModule)
}

const loggerModule = require(loggerName)

describe(`${loggerName} ${mockMethod} test`, () => {
  it('should use the logger mock', () => {
    const mockedLogger = loggerName === 'pino' ? loggerModule() : loggerModule.createLogger()
    mockedLogger.info('test')

    expect(createLogger).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledTimes(1)
  })
})
