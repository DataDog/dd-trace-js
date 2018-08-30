'use strict'

const Writable = require('stream').Writable
const Buffer = require('safe-buffer').Buffer
const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })

class Encoder {
  constructor (bufferSize) {
    this._offset = 0
    this._buffer = Buffer.alloc(bufferSize)
    this._output = new Writable({
      write: (chunk, encoding, next) => {
        const written = chunk.copy(this._buffer, this._offset)
        console.log(this._offset)

        if (written !== chunk.length) {
          console.log(written, chunk.length, this._offset)
          const error = new Error('Buffer overflow')
          error.name = 'RangeError'
          next(error)
        } else {
          this._offset += written
          next()
        }
      }
    })

    this._stream = msgpack.createEncodeStream({ codec })
    this._stream.pipe(this._output)
  }

  encode (trace) {
    this._stream.write(trace)
  }

  buffer () {
    return Buffer.from(this._buffer.buffer, 0, this._offset)
  }

  offset () {
    return this._offset
  }
}

module.exports = Encoder
