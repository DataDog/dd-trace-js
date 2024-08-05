'use strict'

class Table {
  constructor (strings, columnTypes) {
    this.columns = {}
    this.length = 0

    this._capacity = 1024
    this._strings = strings

    for (const [name, TypedArray] of Object.entries(columnTypes)) {
      const buffer = new ArrayBuffer(this._capacity, { maxByteLength: 2 ** 32 })

      this.columns[name] = new TypedArray(buffer)
    }
  }

  get byteLength () {
    const rowLength = Object.values(this.columns)
      .reduce((a, b) => a + b.BYTES_PER_ELEMENT, 0)

    return this.length * rowLength
  }

  reserve (count = 1) {
    if (this.length + count > this._capacity) {
      this._capacity = this._capacity * 2

      for (const column of Object.values(this.columns)) {
        column.buffer.resize(this._capacity * column.buffer.BYTES_PER_ELEMENT)
      }
    }
  }
}

module.exports = { Table }
