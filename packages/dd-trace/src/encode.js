'use strict'

const msgpack = require('msgpack-lite')

let codec

module.exports = data => {
  codec = codec || msgpack.createCodec({ int64: true })

  return msgpack.encode(data, { codec })
}
