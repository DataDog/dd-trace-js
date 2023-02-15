/* eslint-disable */
'use strict'

const addons = {
    'linux-x64': './addons/node-napi-rs.linux-x64.node',
    'darwin-arm64': './addons/node-napi-rs.darwin-arm64.node',
}  

const target = `${process.platform}-${process.arch}`

if (!addons.hasOwnProperty(target)) {
    console.log(`the NAPI_RS exporter does not support ${target}`);
}

const sendTrace = require(addons[target]).sendTrace

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