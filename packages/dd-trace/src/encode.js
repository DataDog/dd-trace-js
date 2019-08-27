'use strict'

const msgpack = require('msgpack-lite')
const { Int64BE, Uint64BE } = require('int64-buffer') // TODO: remove dependency

let codec

module.exports = data => {
  codec = codec || msgpack.createCodec({ int64: true })

  data = data.map(span => {
    return Object.assign({}, span, {
      trace_id: new Uint64BE(span.trace_id.toBuffer().slice(-8)),
      span_id: new Uint64BE(span.span_id.toBuffer().slice(-8)),
      parent_id: span.parent_id ? new Uint64BE(span.parent_id.toBuffer().slice(-8)) : null,
      start: new Int64BE(span.start),
      duration: new Int64BE(span.duration)
    })
  })

  return msgpack.encode(data, { codec })
}
