'use strict'

const pino = require('pino')

jest.mock('pino', () => jest.fn(() => ({
  info: jest.fn(),
})))

describe('pino mock test', () => {
  it('uses the Pino mock', () => {
    const logger = pino()
    logger.info('test')
    expect(pino).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledTimes(1)
  })
})
