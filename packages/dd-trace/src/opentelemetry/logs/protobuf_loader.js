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
const fs = require('fs')

let _root = null
let _logsService = null
let _resourceLogs = null
let _scopeLogs = null
let _logRecord = null
let _severityNumber = null

function loadProtobufDefinitions () {
  if (_root) {
    return { _root, _logsService, _resourceLogs, _scopeLogs, _logRecord, _severityNumber }
  }

  try {
    // Load the proto files
    const protoDir = __dirname
    const protoFiles = [
      'common.proto',
      'resource.proto',
      'logs.proto',
      'payload.proto'
    ].map(file => path.join(protoDir, file))

    if (!protoFiles.every(file => fs.existsSync(file))) {
      throw new Error('Proto files not found')
    }

    _root = protobuf.loadSync(protoFiles)

    // Get the message types
    _logsService = _root.lookupType('opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest')
    _resourceLogs = _root.lookupType('opentelemetry.proto.logs.v1.ResourceLogs')
    _scopeLogs = _root.lookupType('opentelemetry.proto.logs.v1.ScopeLogs')
    _logRecord = _root.lookupType('opentelemetry.proto.logs.v1.LogRecord')
    _severityNumber = _root.lookupEnum('opentelemetry.proto.logs.v1.SeverityNumber')

    return { _root, _logsService, _resourceLogs, _scopeLogs, _logRecord, _severityNumber }
  } catch (error) {
    throw new Error(`Failed to load protobuf definitions: ${error.message}`)
  }
}

// Lazy load the protobuf definitions
function getProtobufTypes () {
  return loadProtobufDefinitions()
}

module.exports = {
  getProtobufTypes,
  loadProtobufDefinitions
}
