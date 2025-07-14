'use strict'

const { expect } = require('chai')

const logger = require('./logger')
const sum = require('./sum')

describe('test', () => {
  it('should return true', () => {
    logger.log('info', 'Hello simple log!')

    expect(true).to.be.true
    expect(sum(1, 2)).to.equal(3)
  })
})
