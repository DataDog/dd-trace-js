import { describe, expect, it, jest } from '@jest/globals'

const loggerName = process.env.TEST_LOGGER
const logger = { info: jest.fn() }
const createLogger = jest.fn(() => logger)
const defaultExport = loggerName === 'pino' ? createLogger : { createLogger }

jest.unstable_mockModule(loggerName, () => ({ default: defaultExport }))

const { default: loggerModule } = await import(loggerName)

describe(`${loggerName} ESM mock test`, () => {
  it('uses the logger mock', () => {
    const mockedLogger = loggerName === 'pino' ? loggerModule() : loggerModule.createLogger()
    mockedLogger.info('test')

    expect(createLogger).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledTimes(1)
  })
})
