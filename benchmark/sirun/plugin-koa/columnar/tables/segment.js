'use strict'

const { Table } = require('../table')

class SegmentStartTable extends Table {
  constructor () {
    super({
      time: BigUint64Array,
      ticks: BigUint64Array,
      trace_id_hi: BigUint64Array,
      trace_id_lo: BigUint64Array,
      segment_id: BigUint64Array
    })
  }

  insert (segment) {
    this.reserve()

    this.columns.time[this.length] = BigInt(Date.now())
    this.columns.ticks[this.length] = process.hrtime.bigint()
    this.columns.trace_id_hi[this.length] = segment.traceId
    this.columns.trace_id_lo[this.length] = segment.traceId >> 64n
    this.columns.segment_id[this.length] = segment.segmentId

    this.length++
  }
}

module.exports = { SegmentStartTable }
