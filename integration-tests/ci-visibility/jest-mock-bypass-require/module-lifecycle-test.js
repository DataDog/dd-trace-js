'use strict'

const loggerName = process.env.TEST_LOGGER

describe(`${loggerName} module lifecycle`, () => {
  it('reloads the logger after jest.resetModules()', () => {
    const firstLoggerModule = require(loggerName)
    firstLoggerModule.ddTestMutation = true

    jest.resetModules()

    const reloadedLoggerModule = require(loggerName)
    expect(reloadedLoggerModule).not.toBe(firstLoggerModule)
    expect(reloadedLoggerModule.ddTestMutation).toBeUndefined()
  })

  it('uses a separate logger inside jest.isolateModules()', () => {
    const loggerModule = require(loggerName)
    let isolatedLoggerModule

    jest.isolateModules(() => {
      isolatedLoggerModule = require(loggerName)
    })

    expect(isolatedLoggerModule).not.toBe(loggerModule)
    expect(require(loggerName)).toBe(loggerModule)
  })
})
