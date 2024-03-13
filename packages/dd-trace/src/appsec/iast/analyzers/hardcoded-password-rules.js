/* eslint-disable max-len */
'use strict'

const { NameAndValue } = require('./hardcoded-rule-type')

module.exports = [
  {
    id: 'hardcoded-password',

    // eslint-disable-next-line max-len
    regex: /(?:pwd|pswd|pass|secret)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([0-9a-z\-_.=]{10,150})(?:['"\s\x60;]|$)/i,
    type: NameAndValue
  }
]
