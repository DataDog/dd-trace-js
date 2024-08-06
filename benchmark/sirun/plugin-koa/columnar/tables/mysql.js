'use strict'

const { Table } = require('../table')

class MysqlQueryStartTable extends Table {
  constructor () {
    super({
      ticks: BigUint64Array,
      segment_id: BigUint64Array,
      span_id: BigUint64Array,
      parent_id: BigUint64Array,
      sql_query: Uint16Array,
      sql_db: Uint16Array,
      sql_user: Uint16Array,
      sql_host: Uint16Array,
      sql_port: Uint16Array
    })
  }

  insert (query, spanContext) {
    this.reserve()

    this.columns.ticks[this.length] = process.hrtime.bigint()
    this.columns.segment_id[this.length] = spanContext.segment.segmentId
    this.columns.span_id[this.length] = spanContext.spanId
    this.columns.parent_id[this.length] = spanContext.parentId
    this.columns.sql_query[this.length] = this._cache(query.sql)
    this.columns.sql_db[this.length] = this._cache(query.database)
    this.columns.sql_user[this.length] = this._cache(query.user)
    this.columns.sql_host[this.length] = this._cache(query.host)
    this.columns.sql_port[this.length] = this._cache(query.port)

    this.length++
  }
}

module.exports = { MysqlQueryStartTable }
