/* eslint-disable */
'use strict'

const { sendTrace } = require("./node-napi-rs.darwin-arm64.node")

class NAPI_RSExporter {
  constructor () {}

  export (spans) {
    for (const span of spans) {
      span.trace_id = parseInt(span.trace_id, 16)
      span.parent_id = parseInt(span.parent_id, 16)
      span.span_id = parseInt(span.span_id, 16)
    }

    const payload = JSON.stringify(spans)

    sendTrace(payload, 0)
  }
}

module.exports = NAPI_RSExporter
