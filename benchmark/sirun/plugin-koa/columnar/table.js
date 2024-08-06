'use strict'

const { Dictionary } = require('./dictionary')

class Table {
  constructor (columnTypes) {
    this.columns = {}
    this.dictionary = new Dictionary()
    this.length = 0
    this.width = 0

    this._capacity = 1024

    for (const [name, TypedArray] of Object.entries(columnTypes)) {
      this.columns[name] = new TypedArray(this._capacity)
      this.width += TypedArray.BYTES_PER_ELEMENT
    }
  }

  get byteLength () {
    return this.length * this.width
  }

  reset () {
    this.length = 0
    this.dictionary.reset()
  }

  reserve (count = 1) {
    if (this.length + count > this._capacity) {
      this._capacity = this._capacity * 2

      for (const [name, column] of Object.entries(this.columns)) {
        this.columns[name] = new column.constructor(this._capacity)
        this.columns[name].set(column)
      }
    }
  }

  _cache (value) {
    return this.dictionary.get(value)
  }
}

module.exports = { Table }
