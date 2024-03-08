'use strict'

const { HARDCODED_SECRET } = require('../vulnerabilities')

const HardcodedBaseAnalyzer = require('./hardcoded-base-analyzer')

const ALL_RULES = require('./hardcoded-secrets-rules')
const VALUE_ONLY_RULES = ALL_RULES.filter(rule => rule.mode === 'ValueOnly')

class HardcodedSecretAnalyzer extends HardcodedBaseAnalyzer {
  constructor () {
    super(HARDCODED_SECRET)
  }

  getAllRules () {
    return ALL_RULES
  }

  getValueOnlyRules () {
    return VALUE_ONLY_RULES
  }
}

module.exports = new HardcodedSecretAnalyzer()
