'use strict'

const { ExceptionTable } = require('./error')
const { MysqlQueryStartTable } = require('./mysql')
const { SegmentStartTable } = require('./segment')
const { SpanFinishTable } = require('./span')
const { AddMetricTable, AddTagTable } = require('./tag')
const { WebRequestFinishTable, WebRequestStartTable } = require('./web')
const events = require('../events')

module.exports = {
  [events.ADD_METRIC]: AddMetricTable,
  [events.ADD_TAG]: AddTagTable,
  [events.ERROR]: ExceptionTable,
  [events.MYSQL_QUERY_START]: MysqlQueryStartTable,
  [events.SEGMENT_START]: SegmentStartTable,
  [events.SPAN_FINISH]: SpanFinishTable,
  [events.WEB_REQUEST_FINISH]: WebRequestFinishTable,
  [events.WEB_REQUEST_START]: WebRequestStartTable
}
