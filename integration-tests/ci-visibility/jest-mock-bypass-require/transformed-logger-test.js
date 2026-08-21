'use strict'

const loggerName = process.env.TEST_LOGGER

describe(`${loggerName} Jest transformation`, () => {
  it('loads the transformed logger export', () => {
    expect(require(loggerName).ddJestTransformed).toBe(true)
  })
})
