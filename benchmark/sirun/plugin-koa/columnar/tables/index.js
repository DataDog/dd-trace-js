'use strict'

const { ExceptionTable } = require('./error')
const { MysqlQueryStartTable } = require('./mysql')
const { SegmentStartTable } = require('./segment')
const { SpanFinishTable } = require('./span')
const { AddMetricTable, AddTagTable } = require('./tag')
const { WebRequestFinishTable, WebRequestStartTable } = require('./web')
const {
  ADD_METRIC,
  ADD_TAG,
  ERROR,
  MYSQL_QUERY_START,
  SEGMENT_START,
  SPAN_FINISH,
  WEB_REQUEST_FINISH,
  WEB_REQUEST_START
} = require('../events')

module.exports = {
  [ADD_METRIC]: AddMetricTable,
  [ADD_TAG]: AddTagTable,
  [ERROR]: ExceptionTable,
  [MYSQL_QUERY_START]: MysqlQueryStartTable,
  [SEGMENT_START]: SegmentStartTable,
  [SPAN_FINISH]: SpanFinishTable,
  [WEB_REQUEST_FINISH]: WebRequestFinishTable,
  [WEB_REQUEST_START]: WebRequestStartTable
}
