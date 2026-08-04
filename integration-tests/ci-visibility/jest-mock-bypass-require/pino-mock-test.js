'use strict'

const pino = require('pino')
const logger = require('./pino-logger')

jest.mock('pino', () => jest.fn(() => ({
  info: jest.fn(),
})))

describe('pino mock test', () => {
  it('should use the pino mock', () => {
    logger.info('test')
    expect(pino).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledTimes(1)
  })
})
