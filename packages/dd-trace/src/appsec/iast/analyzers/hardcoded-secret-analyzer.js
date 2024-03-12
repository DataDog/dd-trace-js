'use strict'

const { HARDCODED_SECRET } = require('../vulnerabilities')

const HardcodedBaseAnalyzer = require('./hardcoded-base-analyzer')

const allRules = require('./hardcoded-secrets-rules')

class HardcodedSecretAnalyzer extends HardcodedBaseAnalyzer {
  constructor () {
    super(HARDCODED_SECRET, allRules, allRules.filter(rule => rule.type === 'ValueOnly'))
  }
}

module.exports = new HardcodedSecretAnalyzer()
