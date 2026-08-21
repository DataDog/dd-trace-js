'use strict'

const loggerName = process.env.TEST_LOGGER
const loggerModule = require(loggerName)

describe(`${loggerName} workspace resolution`, () => {
  it('loads the logger resolved beside the test suite', () => {
    expect(loggerModule).toEqual({ suiteLocalLogger: loggerName })
  })
})
