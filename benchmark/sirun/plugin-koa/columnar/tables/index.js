'use strict'

const events = require('../events')
const { ExceptionTable } = require('./error')
const { MysqlQueryStartTable } = require('./mysql')
const { SegmentStartTable } = require('./segment')
const { SpanFinishTable } = require('./span')
const { AddMetricTable, AddTagTable } = require('./tag')
const { WebRequestFinishTable, WebRequestStartTable } = require('./web')
const { EventTable } = require('./event')
const { ProcessInfoTable } = require('./process')
const { ConfigTable } = require('./config')

module.exports = {
  [events.EVENT]: EventTable,
  [events.PROCESS_INFO]: ProcessInfoTable,
  [events.CONFIG]: ConfigTable,
  [events.ADD_METRIC]: AddMetricTable,
  [events.ADD_TAG]: AddTagTable,
  [events.ERROR]: ExceptionTable,
  [events.MYSQL_QUERY_START]: MysqlQueryStartTable,
  [events.SEGMENT_START]: SegmentStartTable,
  [events.SPAN_FINISH]: SpanFinishTable,
  [events.WEB_REQUEST_FINISH]: WebRequestFinishTable,
  [events.WEB_REQUEST_START]: WebRequestStartTable
}
