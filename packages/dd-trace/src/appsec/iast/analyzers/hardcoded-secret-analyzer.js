'use strict'

const { HARDCODED_SECRET } = require('../vulnerabilities')
const HardcodedBaseAnalyzer = require('./hardcoded-base-analyzer')
const { ValueOnly } = require('./hardcoded-rule-type')

const allRules = require('./hardcoded-secret-rules')

class HardcodedSecretAnalyzer extends HardcodedBaseAnalyzer {
  constructor () {
    super(HARDCODED_SECRET, allRules, allRules.filter(rule => rule.type === ValueOnly))
  }
}

module.exports = new HardcodedSecretAnalyzer()
