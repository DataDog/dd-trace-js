'use strict'

const { Table } = require('../table')

class ExceptionTable extends Table {
  constructor () {
    super({
      segment_id: BigUint64Array,
      span_id: BigUint64Array,
      error_name: Uint16Array,
      error_message: Uint16Array,
      error_stack: Uint16Array
    })
  }

  insert (error = null, spanContext) {
    this.reserve()

    this.columns.segment_id[this.length] = spanContext.segment.segmentId
    this.columns.span_id[this.length] = spanContext.spanId
    this.columns.error_name[this.length] = this._cache(error?.name)
    this.columns.error_message[this.length] = this._cache(error?.message)
    this.columns.error_stack[this.length] = this._cache(error?.stack)

    this.length++
  }
}

module.exports = { ExceptionTable }
