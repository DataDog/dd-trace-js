'use strict'

const { Table } = require('../table')

class WebRequestStartTable extends Table {
  constructor () {
    super({
      ticks: BigUint64Array,
      segment_id: BigUint64Array,
      span_id: BigUint64Array,
      parent_id: BigUint64Array,
      component: Uint16Array,
      http_method: Uint16Array,
      http_route: Uint16Array,
      http_url: Uint16Array
    })
  }

  insert (req, component, spanContext) {
    this.reserve()

    this.columns.ticks[this.length] = process.hrtime.bigint()
    this.columns.segment_id[this.length] = spanContext.segment.segmentId
    this.columns.span_id[this.length] = spanContext.spanId
    this.columns.parent_id[this.length] = spanContext.parentId
    this.columns.component[this.length] = this._cache(component)
    this.columns.http_method[this.length] = this._cache(req.method)
    this.columns.http_url[this.length] = this._cache(req.url)
    this.columns.http_route[this.length] = this._cache(req.url)

    this.length++
  }
}

class WebRequestFinishTable extends Table {
  constructor () {
    super({
      ticks: BigUint64Array,
      segment_id: BigUint64Array,
      span_id: BigUint64Array,
      http_status: Uint16Array
    })
  }

  insert (res, spanContext) {
    this.reserve()

    this.columns.ticks[this.length] = process.hrtime.bigint()
    this.columns.segment_id[this.length] = spanContext.segment.segmentId
    this.columns.span_id[this.length] = spanContext.spanId
    this.columns.http_status[this.length] = res.statusCode

    this.length++
  }
}

module.exports = { WebRequestStartTable, WebRequestFinishTable }
