'use strict'

const { HARDCODED_SECRET } = require('../vulnerabilities')

const secretRules = require('./hardcoded-secrets-rules')
const HardcodedBaseAnalyzer = require('./hardcoded-base-analyzer')

class HardcodedSecretAnalyzer extends HardcodedBaseAnalyzer {
  constructor () {
    super(HARDCODED_SECRET)
  }

  get rules () {
    return secretRules
  }
}

module.exports = new HardcodedSecretAnalyzer()
