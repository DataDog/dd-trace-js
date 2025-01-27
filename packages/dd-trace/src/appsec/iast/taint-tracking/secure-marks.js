'use strict'

const vulnerabilities = require('../vulnerabilities')
const { getNextSecureMark } = require('./secure-marks-generator')

const marks = {}
Object.keys(vulnerabilities).forEach(vulnerability => {
  marks[vulnerability + '_MARK'] = getNextSecureMark()
})

let asterisk = 0x0
Object.values(marks).forEach(mark => { asterisk |= mark })

marks.ASTERISK_MARK = asterisk
marks.CUSTOM_SECURE_MARK = getNextSecureMark()

function getMarkFromVulnerabilityType (vulnerabilityType) {
  vulnerabilityType = vulnerabilityType?.trim()
  const mark = vulnerabilityType === '*' ? 'ASTERISK_MARK' : vulnerabilityType + '_MARK'
  return marks[mark]
}

module.exports = {
  ...marks,
  getMarkFromVulnerabilityType,

  ALL: marks
}
