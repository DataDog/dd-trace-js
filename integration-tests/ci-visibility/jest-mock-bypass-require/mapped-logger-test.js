'use strict'

const loggerModule = require(process.env.TEST_LOGGER)

describe(`${process.env.TEST_LOGGER} mapped logger test`, () => {
  it('uses the mapped logger', () => {
    expect(loggerModule).toEqual({ mapped: true })
  })
})
