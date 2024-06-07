'use strict'

const { getNextSecureMark, reset } = require('../../../../src/appsec/iast/taint-tracking/secure-marks-generator')
describe('test secure marks generator', () => {
  beforeEach(() => {
    reset()
  })

  after(() => {
    reset()
  })

  it('should generate numbers in order', () => {
    for (let i = 0; i < 100; i++) {
      expect(getNextSecureMark()).to.be.equal(1 << i)
    }
  })
})
