'use strict'

const { HARDCODED_PASSWORD } = require('../vulnerabilities')
const HardcodedBaseAnalyzer = require('./hardcoded-base-analyzer')

const ALL_RULES = [
  {
    id: 'generic-password',

    // eslint-disable-next-line max-len
    regex: /(?:pwd|pswd|pass|secret)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([0-9a-z\-_.=]{10,150})(?:['"\s\x60;]|$)/i,
    mode: 'NameAndValue'
  }
]

const VALUE_ONLY_RULES = []

class HardcodedPasswordAnalyzer extends HardcodedBaseAnalyzer {
  constructor () {
    super(HARDCODED_PASSWORD)
  }

  getAllRules () {
    return ALL_RULES
  }

  getValueOnlyRules () {
    return VALUE_ONLY_RULES
  }
}

module.exports = new HardcodedPasswordAnalyzer()
