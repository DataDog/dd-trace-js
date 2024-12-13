'use strict'

const msgpack = require('@msgpack/msgpack')

// const service = process.env.DD_SERVICE || 'unnamed-node-app'

class Encoder {
  encode (tables) {
    const tableEntries = Object.entries(tables).filter(([_, table]) => table.length > 0)
    const formattedTables = []

    for (const [type, rawTable] of tableEntries) {
      const table = {
        event_type: Number(type),
        size: rawTable.length,
        dictionaries: {},
        columns: {}
      }

      for (const [name, dictionary] of Object.entries(rawTable.dictionaries)) {
        table.dictionaries[name] = dictionary._strings
      }

      for (const [name, column] of Object.entries(rawTable.columns)) {
        table.columns[name] = column.subarray(0, rawTable.length)
      }

      formattedTables.push(table)
    }

    const bytes = msgpack.encode(formattedTables)

    return bytes
  }
}

module.exports = { Encoder }
