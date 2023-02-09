/* eslint-disable */
'use strict'

let sendTrace

if (process.platform == 'linux' && process.arch == 'x64') {
  sendTrace = require("node-loader!./node-napi-rs.linux-x64.node").sendTrace
} else if (process.platform == 'darwin' && process.arch == 'arm64') {
  sendTrace = require("node-loader!./node-napi-rs.darwin-arm64.node").sendTrace
} else {
  console.log("the NAPI_RS exporter does not support " + process.platform + "-" + process.arch);
}

class NAPIRSExporter {
  constructor () {}

  export (spans) {
    for (const span of spans) {
      span.trace_id = parseInt(span.trace_id, 16)
      span.parent_id = parseInt(span.parent_id, 16)
      span.span_id = parseInt(span.span_id, 16)
    }

    const payload = JSON.stringify(spans)

    sendTrace(payload, 0);
  }
}

module.exports = NAPIRSExporter
