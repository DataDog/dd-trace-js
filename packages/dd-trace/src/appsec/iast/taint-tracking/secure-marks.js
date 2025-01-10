'use strict'

const vulnerabilities = require('../vulnerabilities')
const { getNextSecureMark } = require('./secure-marks-generator')

const marks = {}
Object.keys(vulnerabilities).forEach(vulnerability => {
  marks[vulnerability + '_MARK'] = getNextSecureMark()
})

let [asterisk, ...rest] = Object.values(marks)
rest.forEach(mark => { asterisk |= mark })

marks['*'] = asterisk

marks.CUSTOM_SECURE_MARK = getNextSecureMark()

function getMarkFromVulnerabilityType (vulnerabilityType) {
  return marks[vulnerabilityType + '_MARK']
}

module.exports = {
  ...marks,
  getMarkFromVulnerabilityType
}
