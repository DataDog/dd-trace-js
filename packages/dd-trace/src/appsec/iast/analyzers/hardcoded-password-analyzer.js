'use strict'

const { HARDCODED_PASSWORD } = require('../vulnerabilities')
const HardcodedBaseAnalyzer = require('./hardcoded-base-analyzer')

const allRules = require('./hardcoded-password-rules')

class HardcodedPasswordAnalyzer extends HardcodedBaseAnalyzer {
  constructor () {
    super(HARDCODED_PASSWORD, allRules)
  }
}

module.exports = new HardcodedPasswordAnalyzer()
