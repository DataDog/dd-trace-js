'use strict'

const { MsgpackEncoder } = require('./msgpack/encoder')
const Chunk = require('./msgpack/chunk')

const msgpack = new MsgpackEncoder()

// const service = process.env.DD_SERVICE || 'unnamed-node-app'

class Encoder {
  encode (tables) {
    const bytes = new Chunk()
    const tableEntries = Object.entries(tables)

    msgpack.encodeMapPrefix(bytes, 1)

    msgpack.encodeString(bytes, 'tables')
    msgpack.encodeMapPrefix(bytes, tableEntries.length)

    for (const [type, table] of tableEntries) {
      const columnEntries = Object.entries(table.columns)

      msgpack.encodeShort(bytes, Number(type)) // TODO: signed int
      msgpack.encodeMapPrefix(bytes, 2)

      msgpack.encodeString(bytes, 'dictionary')
      msgpack.encodeArrayPrefix(bytes, table.dictionary.length)
      msgpack.encodeRaw(bytes, table.dictionary.data)

      msgpack.encodeString(bytes, 'columns')
      msgpack.encodeMapPrefix(bytes, columnEntries.length)

      for (const [name, column] of columnEntries) {
        msgpack.encodeString(bytes, name)
        msgpack.encodeBin(bytes, column.subarray(0, table.length))
      }
    }

    return bytes
  }
}

module.exports = { Encoder }
