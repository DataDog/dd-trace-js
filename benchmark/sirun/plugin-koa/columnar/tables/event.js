'use strict'

const { Table } = require('../table')

class EventTypeTable extends Table {
  constructor () {
    super({
      type: Uint8Array
    })
  }

  insert (type) {
    this.reserve()

    this.columns.type[this.length] = type

    this.length++
  }
}

module.exports = { EventTypeTable }
