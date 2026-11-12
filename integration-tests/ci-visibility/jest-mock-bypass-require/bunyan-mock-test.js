'use strict'

const bunyan = require('bunyan')

jest.mock('bunyan', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
  })),
}))

describe('bunyan mock test', () => {
  it('uses the Bunyan mock', () => {
    const logger = bunyan.createLogger()
    logger.info('test')
    expect(bunyan.createLogger).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledTimes(1)
  })
})
