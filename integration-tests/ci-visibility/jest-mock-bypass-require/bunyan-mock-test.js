'use strict'

const bunyan = require('bunyan')
const logger = require('./bunyan-logger')

jest.mock('bunyan', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
  })),
}))

describe('bunyan mock test', () => {
  it('should use the bunyan mock', () => {
    logger.info('test')
    expect(bunyan.createLogger).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledTimes(1)
  })
})
