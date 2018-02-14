'use strict'

const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })

module.exports = data => msgpack.encode(data, { codec })
