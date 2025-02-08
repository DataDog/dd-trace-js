'use strict'

const { assert } = require('chai')
const {
  SQL_INJECTION_MARK,
  getMarkFromVulnerabilityType,
  ASTERISK_MARK,
  ALL
} = require('../../../../src/appsec/iast/taint-tracking/secure-marks')
const { SQL_INJECTION } = require('../../../../src/appsec/iast/vulnerabilities')

describe('IAST secure marks', () => {
  it('should generate a mark for each vulnerability', () => {
    const mark = getMarkFromVulnerabilityType(SQL_INJECTION)
    assert.equal(mark, SQL_INJECTION_MARK)
  })

  it('should generate a mark for every vulnerability', () => {
    const mark = getMarkFromVulnerabilityType('*')
    assert.equal(mark, ASTERISK_MARK)
  })

  it('should not be repeated marks (probably due to truncation)', () => {
    const markValues = Object.values(ALL)
    assert.equal(markValues.length, [...new Set(markValues)].length)
  })

  it('should generate marks under 0x100000000 due taint-tracking secure mark length', () => {
    // in theory secure-marks generator can not reach this value with bitwise operations due to 32-bit integer linmits
    const limitMark = 0x100000000

    Object.values(ALL).forEach(mark => assert.isTrue(mark < limitMark))
  })
})
