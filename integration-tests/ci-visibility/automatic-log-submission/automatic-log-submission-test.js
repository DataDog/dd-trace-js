const { createLogger, format, transports } = require('winston')
const { expect } = require('chai')

const logger = createLogger({
  level: 'info',
  exitOnError: false,
  format: format.json(),
  transports: [
    new transports.Console()
  ]
})

describe('test', () => {
  it('should return true', () => {
    logger.log('info', 'Hello simple log!')

    expect(true).to.be.true
  })
})
