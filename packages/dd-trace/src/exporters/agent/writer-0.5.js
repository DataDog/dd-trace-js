'use strict'

const encode = require('../../encode/index-0.5')
const BaseWriter = require('./base-writer')

const arraySizeTwo = Buffer.from([0b10010010])

class Writer extends BaseWriter {
  _reset () {
    super._reset()

    this._strings = Buffer.allocUnsafe(BaseWriter.MAX_SIZE)
    this._stringMap = {}
    this._stringMapLen = 0
    this._stringsBufLen = 3 // 0xdc and then uint16
    this._strings[0] = 0xdc
  }

  _makePayload (traceData) {
    const strings = this._strings.slice(0, this._stringsBufLen)
    const stringsLen = Reflect.ownKeys(this._stringMap).length
    strings.writeUInt16BE(stringsLen, 1)
    return [Buffer.concat([arraySizeTwo, strings, traceData[0]])]
  }
}

Writer._protocolVersion = 'v0.5'
Writer._encode = encode

module.exports = Writer
