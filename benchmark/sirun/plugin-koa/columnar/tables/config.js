'use strict'

const { Table } = require('../table')

class ConfigTable extends Table {
  constructor () {
    super({
      host: Uint16Array
    }, ['host'])
  }

  insert ({ host }) {
    this.reserve()

    this.columns.host[this.length] = this._cache('host', host)

    this.length++
  }
}

module.exports = { ConfigTable }
