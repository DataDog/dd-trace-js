'use strict'

const winston = require('winston')
const logger = require('./logger')

jest.mock('winston', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
  })),
  format: {
    simple: jest.fn(() => ({}))
  },
  transports: {
    Console: jest.fn()
  }
}))

describe('winston mock test', () => {
  it('should call winston.createLogger when mocked', () => {
    logger.info('test')
    expect(winston.createLogger).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledTimes(1)
  })
})
