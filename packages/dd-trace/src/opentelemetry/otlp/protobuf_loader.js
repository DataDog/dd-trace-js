'use strict'

/**
 * @fileoverview Protobuf Loader for OpenTelemetry Logs and Metrics
 *
 * This module loads protobuf definitions for OpenTelemetry logs and metrics.
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
let protoMetricsService = null
let protoAggregationTemporality = null

function getProtobufTypes () {
  if (_root) {
    return {
      protoLogsService,
      protoSeverityNumber,
      protoMetricsService,
      protoAggregationTemporality
    }
  }
  // Load the proto files
  const protoDir = __dirname
  const protoFiles = [
    'common.proto',
    'resource.proto',
    'logs.proto',
    'logs_service.proto',
    'metrics.proto',
    'metrics_service.proto'
  ].map(file => path.join(protoDir, file))

  _root = protobuf.loadSync(protoFiles)

  // Get the message types for logs
  protoLogsService = _root.lookupType('opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest')
  protoSeverityNumber = _root.lookupEnum('opentelemetry.proto.logs.v1.SeverityNumber')

  // Get the message types for metrics
  protoMetricsService = _root.lookupType('opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest')
  protoAggregationTemporality = _root.lookupEnum('opentelemetry.proto.metrics.v1.AggregationTemporality')

  return {
    protoLogsService,
    protoSeverityNumber,
    protoMetricsService,
    protoAggregationTemporality
  }
}

module.exports = {
  getProtobufTypes,
}
