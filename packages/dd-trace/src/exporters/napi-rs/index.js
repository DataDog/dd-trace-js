/* eslint-disable */
'use strict'

let sendTrace

switch(process.arch) {
  case 'x64':
    sendTrace = require("./node-napi-rs.linux-x64-gnu.node").sendTrace
    break;
  case 'arm64':
    sendTrace = require("./node-napi-rs.darwin-arm64.node").sendTrace
    break;
}

switch(process.platform) {
  case 'darwin':
    console.log("darwin platform");
    break;
  case 'linux':
    console.log("linux platform");
    break;
  default:
    console.log("default platform");
}

class NAPI_RSExporter {
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

module.exports = NAPI_RSExporter
