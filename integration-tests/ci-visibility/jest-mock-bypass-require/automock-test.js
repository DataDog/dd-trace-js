'use strict'

jest.enableAutomock()

const loggerName = process.env.TEST_LOGGER
const loggerModule = require(loggerName)

describe(`${loggerName} automock test`, () => {
  it('uses the automocked logger', () => {
    const createLogger = loggerName === 'pino' ? loggerModule : loggerModule.createLogger

    expect(jest.isMockFunction(createLogger)).toBe(true)
  })
})
