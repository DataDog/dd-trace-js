'use strict'

const { MsgpackEncoder } = require('./msgpack/encoder')
const Chunk = require('./msgpack/chunk')

const msgpack = new MsgpackEncoder()

// const service = process.env.DD_SERVICE || 'unnamed-node-app'

class Encoder {
  encode (strings, types, tables) {
    const bytes = new Chunk()

    msgpack.encodeMapPrefix(bytes, 3)

    msgpack.encodeString(bytes, 'types')
    this._encodeTypes(bytes, types)

    msgpack.encodeString(bytes, 'tables')
    this._encodeTables(bytes, tables)

    msgpack.encodeString(bytes, 'strings')
    this._encodeStrings(bytes, strings)

    return bytes
  }

  _encodeTables (bytes, tables) {
    const tableEntries = Object.entries(tables)

    msgpack.encodeMapPrefix(bytes, tableEntries.length)

    for (const [type, table] of tableEntries) {
      const columnEntries = Object.entries(table.columns)

      msgpack.encodeShort(bytes, Number(type)) // TODO: signed int
      msgpack.encodeMapPrefix(bytes, columnEntries.length)

      for (const [name, column] of columnEntries) {
        msgpack.encodeString(bytes, name)
        msgpack.encodeBin(bytes, column.subarray(0, table.length))
      }
    }
  }

  _encodeTypes (bytes, types) {
    msgpack.encodeBin(bytes, types)
  }

  _encodeStrings (bytes, strings) {
    msgpack.encodeArrayPrefix(bytes, strings.length)
    msgpack.copy(bytes, strings.data)
  }
}

module.exports = { Encoder }
