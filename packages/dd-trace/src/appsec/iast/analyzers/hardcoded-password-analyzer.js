'use strict'

const { HARDCODED_PASSWORD } = require('../vulnerabilities')
const HardcodedBaseAnalyzer = require('./hardcoded-base-analyzer')

const passwordRules = [
  {
    id: 'generic-password',

    // eslint-disable-next-line max-len
    regex: /(?:pwd|pswd|pass|secret)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([0-9a-z\-_.=]{10,150})(?:['"\s\x60;]|$)/i
  }
]

class HardcodedPasswordAnalyzer extends HardcodedBaseAnalyzer {
  constructor () {
    super(HARDCODED_PASSWORD)
  }

  get rules () {
    return passwordRules
  }
}

module.exports = new HardcodedPasswordAnalyzer()
