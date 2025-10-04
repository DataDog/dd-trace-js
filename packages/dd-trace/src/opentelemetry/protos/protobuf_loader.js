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
let protoLogsService = null
let protoSeverityNumber = null
let protoMetricsService = null
let protoAggregationTemporality = null

function getProtobufTypes () {
  if (_root) {
    return { protoLogsService, protoSeverityNumber, protoMetricsService, protoAggregationTemporality }
  }
  // Load the proto files
  const protoDir = __dirname
  const protoFiles = [
    'common.proto',
    'resource.proto',
    'logs.proto',
    'payload.proto',
    'metrics.proto',
    'metrics_payload.proto'
  ].map(file => path.join(protoDir, file))

  if (!protoFiles.every(file => fs.existsSync(file))) {
    throw new Error('Proto files not found')
  }

  _root = protobuf.loadSync(protoFiles)

  // Get the message types
  protoLogsService = _root.lookupType('opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest')
  protoSeverityNumber = _root.lookupEnum('opentelemetry.proto.logs.v1.SeverityNumber')
  protoMetricsService = _root.lookupType('opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest')
  protoAggregationTemporality = _root.lookupEnum('opentelemetry.proto.metrics.v1.AggregationTemporality')

  return { protoLogsService, protoSeverityNumber, protoMetricsService, protoAggregationTemporality }
}

module.exports = {
  getProtobufTypes,
}
