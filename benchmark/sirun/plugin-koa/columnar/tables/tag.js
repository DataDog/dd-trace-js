'use strict'

const { Table } = require('../table')

class AddTagTable extends Table {
  constructor (strings) {
    super(strings, {
      segment_id: BigUint64Array,
      span_id: BigUint64Array,
      key: Uint16Array,
      value: Uint16Array
    })
  }

  insert (key, value, spanContext) {
    this.reserve()

    this.columns.segment_id[this.length] = spanContext.segment.segmentId
    this.columns.span_id[this.length] = spanContext.spanId
    this.columns.key[this.length] = this._strings.get(key)
    this.columns.value[this.length] = this._strings.get(value)

    this.length++
  }
}

class AddMetricTable extends Table {
  constructor (strings) {
    super(strings, {
      segment_id: BigUint64Array,
      span_id: BigUint64Array,
      key: Uint16Array,
      value: Float64Array
    })
  }

  insert (key, value, spanContext) {
    this.reserve()

    this.columns.segment_id[this.length] = spanContext.segment.segmentId
    this.columns.span_id[this.length] = spanContext.spanId
    this.columns.key[this.length] = this._strings.get(key)
    this.columns.value[this.length] = value

    this.length++
  }
}

module.exports = { AddMetricTable, AddTagTable }
