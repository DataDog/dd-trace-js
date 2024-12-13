'use strict'

const { Table } = require('../table')

class EventTable extends Table {
  constructor () {
    super({
      event_type: Uint16Array
    })
  }

  insert (type) {
    this.reserve()

    this.columns.event_type[this.length] = type

    this.length++
  }
}

module.exports = { EventTable }
