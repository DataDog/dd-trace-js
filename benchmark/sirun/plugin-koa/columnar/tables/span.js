'use strict'

const { Table } = require('../table')

class SpanFinishTable extends Table {
  constructor (strings) {
    super(strings, {
      ticks: BigUint64Array,
      segment_id: BigUint64Array,
      span_id: BigUint64Array
    })
  }

  insert (spanContext) {
    this.reserve()

    this.columns.ticks[this.length] = process.hrtime.bigint()
    this.columns.segment_id[this.length] = spanContext.segment.segmentId
    this.columns.span_id[this.length] = spanContext.spanId

    this.length++
  }
}

module.exports = { SpanFinishTable }
