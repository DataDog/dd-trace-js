'use strict'

const { Table } = require('../table')

class AddTagTable extends Table {
  constructor () {
    super({
      segment_id: BigUint64Array,
      span_id: BigUint64Array,
      key: Uint16Array,
      value: Uint16Array
    }, ['key', 'value'])
  }

  insert (key, value, spanContext) {
    this.reserve()

    this.columns.segment_id[this.length] = spanContext.segment.segmentId
    this.columns.span_id[this.length] = spanContext.spanId
    this.columns.key[this.length] = this._cache('key', key)
    this.columns.value[this.length] = this._cache('value', value)

    this.length++
  }
}

class AddMetricTable extends Table {
  constructor () {
    super({
      segment_id: BigUint64Array,
      span_id: BigUint64Array,
      key: Uint16Array,
      value: Float64Array
    }, ['key'])
  }

  insert (key, value, spanContext) {
    this.reserve()

    this.columns.segment_id[this.length] = spanContext.segment.segmentId
    this.columns.span_id[this.length] = spanContext.spanId
    this.columns.key[this.length] = this._cache('key', key)
    this.columns.value[this.length] = value

    this.length++
  }
}

module.exports = { AddMetricTable, AddTagTable }
