'use strict'

const { Table } = require('../table')

class ExceptionTable extends Table {
  constructor () {
    super({
      segment_id: BigUint64Array,
      span_id: BigUint64Array,
      name: Uint16Array,
      message: Uint16Array,
      stack: Uint16Array
    }, ['name', 'message', 'stack'])
  }

  insert (error = null, spanContext) {
    this.reserve()

    this.columns.segment_id[this.length] = spanContext.segment.segmentId
    this.columns.span_id[this.length] = spanContext.spanId
    this.columns.name[this.length] = this._cache('name', error?.name)
    this.columns.message[this.length] = this._cache('message', error?.message)
    this.columns.stack[this.length] = this._cache('stack', error?.stack)

    this.length++
  }
}

module.exports = { ExceptionTable }
