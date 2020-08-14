'use strict'

const encode = require('../../encode')
const BaseWriter = require('./base-writer')

class Writer extends BaseWriter {
  _makePayload (data) {
    return data
  }
}

Writer._encode = encode
Writer._protocolVersion = 'v0.4'

module.exports = Writer
