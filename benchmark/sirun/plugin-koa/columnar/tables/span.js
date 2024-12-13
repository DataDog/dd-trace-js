'use strict'

const { Table } = require('../table')

class SpanStartTable extends Table {
  constructor () {
    super({
      ticks: BigUint64Array,
      segment_id: BigUint64Array,
      span_id: BigUint64Array,
      parent_id: BigUint64Array,
      name: Uint16Array,
      service: Uint16Array,
      resource: Uint16Array,
      span_type: Uint16Array
    }, ['name', 'service', 'resource', 'span_type'])
  }

  insert (spanContext, name, service, resource, type) {
    this.reserve()

    this.columns.ticks[this.length] = process.hrtime.bigint()
    this.columns.segment_id[this.length] = spanContext.segment.segmentId
    this.columns.span_id[this.length] = spanContext.spanId
    this.columns.parent_id[this.length] = spanContext.parentId
    this.columns.name[this.length] = name
    this.columns.service[this.length] = service
    this.columns.resource[this.length] = resource
    this.columns.span_type[this.length] = type

    this.length++
  }
}

class SpanFinishTable extends Table {
  constructor () {
    super({
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

module.exports = { SpanStartTable, SpanFinishTable }
