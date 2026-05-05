'use strict'

// End-to-end test that mirrors .NET's `SystemRuntimeMetricsFlowThroughOtlpPipeline`:
// builds the real MeterProvider + PeriodicMetricReader, registers our runtime
// instruments via otlp_runtime_metrics.start(), forces a flush, and asserts the
// captured OTLP payload contains all expected runtime metric names.

const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('mocha')
const { metrics } = require('@opentelemetry/api')

const MeterProvider = require('../../src/opentelemetry/metrics/meter_provider')
const PeriodicMetricReader = require('../../src/opentelemetry/metrics/periodic_metric_reader')
const OtlpTransformer = require('../../src/opentelemetry/metrics/otlp_transformer')
const otlpRuntimeMetrics = require('../../src/runtime_metrics/otlp_runtime_metrics')

const EXPECTED_METRICS = [
  'v8js.memory.heap.used',
  'v8js.memory.heap.limit',
  'v8js.memory.heap.space.available_size',
  'v8js.memory.heap.space.physical_size',
  'process.memory.usage',
  'process.cpu.utilization',
  'nodejs.eventloop.delay.min',
  'nodejs.eventloop.delay.max',
  'nodejs.eventloop.delay.mean',
  'nodejs.eventloop.delay.p50',
  'nodejs.eventloop.delay.p90',
  'nodejs.eventloop.delay.p99',
  'nodejs.eventloop.utilization',
]

class CapturingExporter {
  constructor () {
    this.exports = []
  }

  // PeriodicMetricReader passes a Map<string, AggregatedMetric> here
  export (metricsMap, callback) {
    const flat = []
    for (const metric of metricsMap.values()) {
      flat.push(metric)
    }
    this.exports.push(flat)
    if (typeof callback === 'function') callback()
  }
}

describe('OTLP runtime metrics — pipeline flow', () => {
  let provider
  let reader
  let exporter

  beforeEach(() => {
    exporter = new CapturingExporter()
    // Long export interval — we trigger via forceFlush instead of waiting
    reader = new PeriodicMetricReader(exporter, 60_000, 'DELTA', 1024)
    provider = new MeterProvider({ reader })
    metrics.setGlobalMeterProvider(provider)
  })

  afterEach(() => {
    otlpRuntimeMetrics.stop()
    if (reader && !reader._isShutdown) reader.shutdown()
    metrics.disable()
  })

  it('exports all 13 runtime metrics through the OTLP pipeline', () => {
    otlpRuntimeMetrics.start({ runtimeMetrics: { enabled: true, eventLoop: true } })

    reader.forceFlush()

    const seen = new Set()
    for (const exportBatch of exporter.exports) {
      for (const metric of exportBatch) {
        seen.add(metric.name)
      }
    }

    for (const name of EXPECTED_METRICS) {
      assert.ok(seen.has(name), `expected ${name} in OTLP export, got: ${[...seen].sort().join(', ')}`)
    }

    assert.equal(seen.size, 13, `expected exactly 13 metrics, got ${seen.size}: ${[...seen].sort().join(', ')}`)

    for (const name of seen) {
      assert.ok(!name.startsWith('runtime.node.'), `${name} should use OTel naming, not DD naming`)
    }
  })

  it('emits the datadog.runtime_metrics scope name', () => {
    otlpRuntimeMetrics.start({ runtimeMetrics: { enabled: true, eventLoop: true } })

    reader.forceFlush()

    let scopeName
    for (const exportBatch of exporter.exports) {
      for (const metric of exportBatch) {
        if (EXPECTED_METRICS.includes(metric.name)) {
          scopeName = metric.instrumentationScope?.name
          break
        }
      }
      if (scopeName) break
    }

    assert.equal(
      scopeName,
      'datadog.runtime_metrics',
      'runtime metrics should use the datadog.runtime_metrics meter name'
    )
  })

  it('observes positive values for memory and event loop metrics', () => {
    otlpRuntimeMetrics.start({ runtimeMetrics: { enabled: true, eventLoop: true } })

    reader.forceFlush()

    function firstValue (metric) {
      const dp = [...(metric?.dataPointMap?.values() || [])][0]
      return dp?.value
    }

    let heapUsedValue
    let memoryUsageValue
    for (const exportBatch of exporter.exports) {
      for (const metric of exportBatch) {
        if (metric.name === 'v8js.memory.heap.used') {
          heapUsedValue = firstValue(metric)
        }
        if (metric.name === 'process.memory.usage') {
          memoryUsageValue = firstValue(metric)
        }
      }
    }

    assert.ok(heapUsedValue > 0, `heap used should be positive, got ${heapUsedValue}`)
    assert.ok(memoryUsageValue > 0, `RSS should be positive, got ${memoryUsageValue}`)
  })

  // Lock in the SDK output shape against the upstream OTel semantic-conventions YAML
  // (model/v8js, model/nodejs, model/process). This mirrors what .NET's
  // `SubmitsOtlpRuntimeMetrics` snapshot test verifies on the wire: that the right
  // metrics carry `sum { isMonotonic: false }` and the right metrics carry `gauge`.
  // Source of truth:
  //   https://github.com/open-telemetry/semantic-conventions/blob/main/model/v8js/metrics.yaml
  //   https://github.com/open-telemetry/semantic-conventions/blob/main/model/nodejs/metrics.yaml
  //   https://github.com/open-telemetry/semantic-conventions/blob/main/model/process/metrics.yaml
  it('emits OTel-spec instrument types end-to-end (sum vs gauge on the wire)', () => {
    otlpRuntimeMetrics.start({ runtimeMetrics: { enabled: true, eventLoop: true } })

    reader.forceFlush()

    const transformer = new OtlpTransformer({}, 'http/json')

    // Map metric name → wire-shape (which top-level field is populated on the OTLP message).
    // Per spec, updowncounter metrics serialize as `sum { isMonotonic: false }`, and gauge
    // metrics serialize as `gauge`. The transformer here is the same one used by the
    // production OTLP HTTP exporter.
    const wireShapes = {}
    for (const exportBatch of exporter.exports) {
      // Use JSON path so the assertion compares strings, not protobuf enum values.
      const json = JSON.parse(transformer.transformMetrics(exportBatch).toString())
      for (const rm of json.resourceMetrics) {
        for (const sm of rm.scopeMetrics) {
          for (const m of sm.metrics) {
            wireShapes[m.name] = {
              hasSum: 'sum' in m,
              hasGauge: 'gauge' in m,
              isMonotonic: m.sum?.isMonotonic === true,
            }
          }
        }
      }
    }

    const expectedSum = [
      // v8js memory metrics — spec: updowncounter
      'v8js.memory.heap.used',
      'v8js.memory.heap.limit',
      'v8js.memory.heap.space.available_size',
      'v8js.memory.heap.space.physical_size',
      // process memory — spec: updowncounter
      'process.memory.usage',
    ]
    const expectedGauge = [
      // process cpu utilization — spec: gauge
      'process.cpu.utilization',
      // nodejs eventloop delays — spec: gauge
      'nodejs.eventloop.delay.min',
      'nodejs.eventloop.delay.max',
      'nodejs.eventloop.delay.mean',
      'nodejs.eventloop.delay.p50',
      'nodejs.eventloop.delay.p90',
      'nodejs.eventloop.delay.p99',
      'nodejs.eventloop.utilization',
    ]

    for (const name of expectedSum) {
      const shape = wireShapes[name]
      assert.ok(shape, `${name} not found on the wire`)
      assert.equal(shape.hasSum, true, `${name} should serialize as sum (updowncounter), got ${JSON.stringify(shape)}`)
      assert.equal(shape.isMonotonic, false, `${name} sum.isMonotonic should be false (updowncounter, not counter)`)
      assert.equal(shape.hasGauge, false, `${name} should NOT serialize as gauge`)
    }

    for (const name of expectedGauge) {
      const shape = wireShapes[name]
      assert.ok(shape, `${name} not found on the wire`)
      assert.equal(shape.hasGauge, true, `${name} should serialize as gauge, got ${JSON.stringify(shape)}`)
      assert.equal(shape.hasSum, false, `${name} should NOT serialize as sum`)
    }
  })
})
