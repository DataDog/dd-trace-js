'use strict'

/**
 * @fileoverview Protobuf Loader for OpenTelemetry Logs
 *
 * This module loads protobuf definitions for OpenTelemetry logs.
 *
 * VERSION SUPPORT:
 * - OTLP Protocol: v1.7.0
 * - Protobuf Definitions: v1.7.0 (vendored from opentelemetry-proto)
 * - Other versions are not supported
 *
 * Reference:
 * - https://github.com/open-telemetry/opentelemetry-proto (v1.7.0)
 */

const protobuf = require('protobufjs')
const path = require('path')

let _root = null
let protoLogsService = null
let protoSeverityNumber = null

function getProtobufTypes () {
  if (_root) {
    return { protoLogsService, protoSeverityNumber }
  }
  // Load the proto files
  const protoDir = __dirname
  const protoFiles = [
    'common.proto',
    'resource.proto',
    'logs.proto',
    'payload.proto'
  ].map(file => path.join(protoDir, file))

  _root = protobuf.loadSync(protoFiles)

  // Get the message types
  protoLogsService = _root.lookupType('opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest')
  protoSeverityNumber = _root.lookupEnum('opentelemetry.proto.logs.v1.SeverityNumber')

  return { protoLogsService, protoSeverityNumber }
}

module.exports = {
  getProtobufTypes,
}
