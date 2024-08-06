'use strict'

const { Client } = require('./client')
const tables = require('./tables')
const { Encoder } = require('./encoder')
const {
  ERROR,
  EVENT_TYPE,
  SEGMENT_START,
  SPAN_FINISH,
  MYSQL_QUERY_START,
  WEB_REQUEST_FINISH,
  WEB_REQUEST_START
} = require('./events')
const { EventTypeTable } = require('./tables/event')

// const service = process.env.DD_SERVICE || 'unnamed-node-app'
const SOFT_LIMIT = 8 * 1024 * 1024 // 8MB
const MAX_EVENTS = 65536
const flushInterval = 2000
const noop = () => {}

class Exporter {
  constructor (limit = SOFT_LIMIT) {
    this._limit = limit
    this._client = new Client()
    this._encoder = new Encoder()
    this._types = new Uint16Array(MAX_EVENTS)
    this._tables = {
      [EVENT_TYPE]: new EventTypeTable()
    }

    this.reset()

    process.once('beforeExit', () => this.flush())
  }

  exception (error, spanContext) {
    this._beforeEncode(ERROR)
    this._tables[ERROR].insert(error, spanContext)
    this._afterEncode(ERROR)
  }

  finishSpan (spanContext) {
    this._beforeEncode(SPAN_FINISH)
    this._tables[SPAN_FINISH].insert(spanContext)
    this._afterEncode(SPAN_FINISH)
  }

  mysqlQueryStart (query, spanContext) {
    this._beforeEncode(MYSQL_QUERY_START)
    this._tables[MYSQL_QUERY_START].insert(query, spanContext)
    this._afterEncode(MYSQL_QUERY_START)
  }

  segmentStart (segment) {
    this._beforeEncode(SEGMENT_START)
    this._tables[SEGMENT_START].insert(segment)
    this._afterEncode(SEGMENT_START)
  }

  webRequestFinish (res, spanContext) {
    this._beforeEncode(WEB_REQUEST_FINISH)
    this._tables[WEB_REQUEST_FINISH].insert(res, spanContext)
    this._afterEncode(WEB_REQUEST_FINISH)
  }

  webRequestStart (req, component, spanContext) {
    this._beforeEncode(WEB_REQUEST_START)
    this._tables[WEB_REQUEST_START].insert(req, component, spanContext)
    this._afterEncode(WEB_REQUEST_START)
  }

  flush (done = noop) {
    if (this._eventCount === 0) return

    const data = this._encoder.encode(this._tables)

    // console.log(data.length)

    this.reset()

    this._timer = clearTimeout(this._timer)

    done()
  }

  reset () {
    this._eventCount = 0

    for (const table of Object.values(this._tables)) {
      table.reset()
    }
  }

  _beforeEncode (eventType) {
    if (!this._timer) {
      this._timer = setTimeout(() => this.flush(), flushInterval).unref()
    }

    if (!this._tables[eventType]) {
      this._tables[eventType] = new tables[eventType]()
    }
  }

  _afterEncode (eventType) {
    this._tables[EVENT_TYPE].insert(eventType)

    if (++this._eventCount >= MAX_EVENTS) {
      this.flush()
    }
  }
}

const exporter = new Exporter()

module.exports = { Exporter, exporter }
