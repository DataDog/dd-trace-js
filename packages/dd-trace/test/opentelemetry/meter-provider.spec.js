'use strict'

// Increase max listeners to avoid warnings in tests
process.setMaxListeners(50)

require('../setup/core')
const assert = require('assert')
const http = require('http')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')
const { metrics } = require('@opentelemetry/api')
const { initializeOpenTelemetryMetrics } = require('../../src/opentelemetry/metrics')
const { protoMetricsService } = require('../../src/opentelemetry/otlp/protobuf_loader').getProtobufTypes()

describe('OpenTelemetry Meter Provider', () => {
  let originalEnv
  let httpStub

  function mockConfig (overrides = {}) {
    return {
      service: 'test-service',
      version: '1.0.0',
      env: 'test',
      tags: {},
      reportHostname: false,
      otelMetricsUrl: 'http://localhost:4318/v1/metrics',
      otelMetricsHeaders: '',
      otelMetricsTimeout: 5000,
      otelMetricsProtocol: 'http/protobuf',
      otelMetricsExportInterval: 100, // Fast for testing
      ...overrides
    }
  }

  function mockOtlpExport (validator) {
    let capturedPayload, capturedHeaders
    let validatorCalled = false

    httpStub = sinon.stub(http, 'request').callsFake((options, callback) => {
      // Only intercept OTLP metrics requests
      if (options.path && options.path.includes('/v1/metrics')) {
        capturedHeaders = options.headers
        const responseHandlers = {}
        const mockRes = {
          statusCode: 200,
          on: (event, handler) => {
            responseHandlers[event] = handler
            return mockRes
          },
          setTimeout: () => mockRes
        }

        const mockReq = {
          write: (data) => { capturedPayload = data },
          end: () => {
            // Detect protocol from Content-Type header
            const contentType = capturedHeaders['Content-Type']
            const isJson = contentType && contentType.includes('application/json')
            
            const decoded = isJson
              ? JSON.parse(capturedPayload.toString())
              : protoMetricsService.decode(capturedPayload)
            
            validator(decoded, capturedHeaders)
            validatorCalled = true
            
            // Trigger the response end event
            if (responseHandlers.end) {
              responseHandlers.end()
            }
          },
          on: () => {},
          once: () => {},
          setTimeout: () => {}
        }
        callback(mockRes)
        return mockReq
      }

      // For other requests (remote config, etc), return a basic mock
      const mockReq = {
        write: () => {},
        end: () => {},
        on: () => {},
        once: () => {},
        setTimeout: () => {}
      }
      callback({ statusCode: 200, on: () => {}, setTimeout: () => {} })
      return mockReq
    })

    // Return function to check if validator was called
    return () => {
      if (!validatorCalled) {
        throw new Error('OTLP export validator was never called - metrics may not have been exported')
      }
    }
  }

  beforeEach(() => {
    originalEnv = { ...process.env }
  })

  afterEach(async () => {
    process.env = originalEnv
    
    // Properly shutdown any active meter provider
    const provider = metrics.getMeterProvider()
    if (provider && provider.shutdown) {
      await provider.shutdown()
    }
    metrics.disable()
    
    if (httpStub) {
      httpStub.restore()
      httpStub = null
    }
    sinon.restore()
    
    // Small delay to allow timers to clear
    await new Promise(resolve => setTimeout(resolve, 10))
  })

  describe('End-to-End Metrics Flow', () => {
    it('initializes and provides functional meter through API', () => {
      initializeOpenTelemetryMetrics(mockConfig())

      const meter = metrics.getMeter('test-meter', '1.0.0')
      
      // Verify meter has all expected methods
      assert(meter)
      assert(typeof meter.createCounter === 'function')
      assert(typeof meter.createHistogram === 'function')
      assert(typeof meter.createUpDownCounter === 'function')
      assert(typeof meter.createObservableGauge === 'function')
    })

    it('records and exports counter metrics via OTLP', (done) => {
      const validator = mockOtlpExport((decoded, capturedHeaders) => {
        assert.strictEqual(capturedHeaders['Content-Type'], 'application/x-protobuf')

        // Verify resource attributes
        const resource = decoded.resourceMetrics[0].resource
        const serviceNameAttr = resource.attributes.find(attr => attr.key === 'service.name')
        assert.strictEqual(serviceNameAttr.value.stringValue, 'test-service')

        // Verify metrics were exported
        const exportedMetrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        const counter = exportedMetrics.find(m => m.name === 'http.requests')
        
        assert(counter, 'Counter metric should be exported')
        assert.strictEqual(counter.sum.isMonotonic, true)
        assert(counter.sum.dataPoints.length > 0)
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('my-app', '1.0.0')
      const requestCounter = meter.createCounter('http.requests', {
        description: 'Total HTTP requests',
        unit: 'requests'
      })
      
      // Record some measurements
      requestCounter.add(1, { method: 'GET', route: '/api/users' })
      requestCounter.add(1, { method: 'POST', route: '/api/users' })

      setTimeout(() => {
        validator()
        done()
      }, 150)
    })

    it('records and exports histogram metrics', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const exportedMetrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        const histogram = exportedMetrics.find(m => m.name === 'request.duration')
        
        assert(histogram, 'Histogram metric should be exported')
        assert(histogram.histogram)
        assert(histogram.histogram.dataPoints.length > 0)
        
        // Verify histogram has buckets
        const dp = histogram.histogram.dataPoints[0]
        assert(Array.isArray(dp.bucketCounts))
        assert(Array.isArray(dp.explicitBounds))
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('my-app')
      const duration = meter.createHistogram('request.duration', { unit: 'ms' })
      
      duration.record(145)
      duration.record(289)
      duration.record(52)

      setTimeout(() => {
        validator()
        done()
      }, 150)
    })

    it('collects and exports observable gauge metrics', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const exportedMetrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        const gauge = exportedMetrics.find(m => m.name === 'memory.usage')
        
        assert(gauge, 'Gauge metric should be exported')
        assert(gauge.gauge)
        assert(gauge.gauge.dataPoints.length > 0, 'Should have data points')
        
        // Verify observed value (can be either asDouble or asInt)
        const dp = gauge.gauge.dataPoints[0]
        const value = parseFloat(dp.asDouble || dp.asInt || 0)
        assert(value > 0, 'Should have observed a value')
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('my-app')
      const memoryGauge = meter.createObservableGauge('memory.usage', { unit: 'bytes' })
      
      memoryGauge.addCallback((observableResult) => {
        const usage = process.memoryUsage().heapUsed
        observableResult.observe(usage, { type: 'heap' })
      })

      setTimeout(() => {
        validator()
        done()
      }, 150)
    })

    it('handles updowncounter metrics correctly', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const exportedMetrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        const updown = exportedMetrics.find(m => m.name === 'queue.size')
        
        assert(updown, 'UpDownCounter metric should be exported')
        assert.strictEqual(updown.sum.isMonotonic, false, 'Should not be monotonic')
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('my-app')
      const queueSize = meter.createUpDownCounter('queue.size', { unit: 'items' })
      
      queueSize.add(10)  // Items added
      queueSize.add(-3)  // Items processed
      queueSize.add(5)   // More items added

      setTimeout(() => {
        validator()
        done()
      }, 150)
    })

    it('exports metrics with JSON protocol', (done) => {
      const validator = mockOtlpExport((decoded, capturedHeaders) => {
        assert.strictEqual(capturedHeaders['Content-Type'], 'application/json')
        
        const exportedMetrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        const counter = exportedMetrics[0]
        
        // Verify JSON format - numbers as strings
        assert.strictEqual(typeof counter.sum.dataPoints[0].timeUnixNano, 'string')
      })

      initializeOpenTelemetryMetrics(mockConfig({
        otelMetricsProtocol: 'http/json'
      }))
      
      const meter = metrics.getMeter('json-app')
      const counter = meter.createCounter('json.test')
      counter.add(42)

      setTimeout(() => {
        validator()
        done()
      }, 150)
    })

    it('includes custom resource attributes from config', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const resource = decoded.resourceMetrics[0].resource
        const attrs = {}
        resource.attributes.forEach(attr => {
          attrs[attr.key] = attr.value.stringValue || attr.value.intValue
        })
        
        assert.strictEqual(attrs['service.name'], 'custom-service')
        assert.strictEqual(attrs['service.version'], '2.0.0')
        assert.strictEqual(attrs['deployment.environment'], 'production')
        assert.strictEqual(attrs['team'], 'platform')
      })

      initializeOpenTelemetryMetrics(mockConfig({
        service: 'custom-service',
        version: '2.0.0',
        env: 'production',
        tags: {
          team: 'platform',
          region: 'us-east-1'
        }
      }))
      
      const meter = metrics.getMeter('app')
      const counter = meter.createCounter('test')
      counter.add(1)

      setTimeout(() => {
        validator()
        done()
      }, 150)
    })

    it('handles multiple instruments and scopes correctly', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const scopeMetrics = decoded.resourceMetrics[0].scopeMetrics
        
        // Should have metrics from different scopes
        assert(scopeMetrics.length >= 1)
        
        // Verify different metric types are present
        const allMetrics = scopeMetrics.flatMap(sm => sm.metrics)
        const hasCounter = allMetrics.some(m => m.sum && m.sum.isMonotonic)
        const hasHistogram = allMetrics.some(m => m.histogram)
        
        assert(hasCounter, 'Should have counter metrics')
        assert(hasHistogram, 'Should have histogram metrics')
      })

      initializeOpenTelemetryMetrics(mockConfig())
      
      // Create meters with different scopes
      const meter1 = metrics.getMeter('service-a', '1.0.0')
      const meter2 = metrics.getMeter('service-b', '2.0.0')
      
      // Create different instruments
      const counter = meter1.createCounter('requests')
      const histogram = meter2.createHistogram('duration')
      
      counter.add(5)
      histogram.record(100)

      setTimeout(() => {
        validator()
        done()
      }, 150)
    })

    it('records metrics with multiple data points and different attributes', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const exportedMetrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        const counter = exportedMetrics.find(m => m.name === 'api.calls')
        
        assert(counter, 'Counter should be present')
        // Should have multiple data points with different attribute combinations
        assert(counter.sum.dataPoints.length >= 2, 'Should have multiple data points')
        
        // Verify attributes are preserved
        const hasMethodAttr = counter.sum.dataPoints.some(dp =>
          dp.attributes && dp.attributes.some(attr => attr.key === 'method')
        )
        assert(hasMethodAttr, 'Should preserve attributes')
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('app')
      const apiCalls = meter.createCounter('api.calls')
      
      // Record with different attributes
      apiCalls.add(10, { method: 'GET', endpoint: '/users' })
      apiCalls.add(5, { method: 'POST', endpoint: '/users' })
      apiCalls.add(3, { method: 'GET', endpoint: '/posts' })

      setTimeout(() => {
        validator()
        done()
      }, 150)
    })

    it('includes hostname in resource attributes when reportHostname is true', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const resource = decoded.resourceMetrics[0].resource
        const hostnameAttr = resource.attributes.find(attr => attr.key === 'host.name')
        
        assert(hostnameAttr, 'Should include host.name attribute')
        assert(hostnameAttr.value.stringValue, 'Hostname should have a value')
      })

      initializeOpenTelemetryMetrics(mockConfig({
        reportHostname: true
      }))
      
      const meter = metrics.getMeter('app')
      const counter = meter.createCounter('test')
      counter.add(1)

      setTimeout(() => {
        validator()
        done()
      }, 150)
    })

    it('handles instrument descriptions and units', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const exportedMetrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        const metric = exportedMetrics.find(m => m.name === 'response.size')
        
        assert(metric, 'Metric should be present')
        assert.strictEqual(metric.unit, 'bytes', 'Unit should be preserved')
        assert.strictEqual(metric.description, 'HTTP response size', 'Description should be preserved')
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('app')
      const responseSize = meter.createHistogram('response.size', {
        description: 'HTTP response size',
        unit: 'bytes'
      })
      
      responseSize.record(1024)
      responseSize.record(2048)

      setTimeout(() => {
        validator()
        done()
      }, 150)
    })

    it('handles large metric values correctly', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const exportedMetrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        const counter = exportedMetrics.find(m => m.name === 'large.counter')
        
        assert(counter, 'Counter should be present')
        assert(counter.sum.dataPoints.length > 0, 'Should have data points')
        // The sum of all data points should be at least 1000000
        const totalValue = counter.sum.dataPoints.reduce((sum, dp) => {
          return sum + parseInt(dp.asInt || 0)
        }, 0)
        assert(totalValue >= 1000000, 'Should handle large values')
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('app')
      const largeCounter = meter.createCounter('large.counter')
      
      largeCounter.add(1000000)
      largeCounter.add(500000)

      setTimeout(() => {
        validator()
        done()
      }, 150)
    })

    it('handles negative values for updowncounter', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const exportedMetrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        const updown = exportedMetrics.find(m => m.name === 'balance')
        
        assert(updown, 'UpDownCounter should be present')
        assert.strictEqual(updown.sum.isMonotonic, false)
        // The aggregated value might be negative or zero
        assert(updown.sum.dataPoints.length > 0)
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('app')
      const balance = meter.createUpDownCounter('balance')
      
      balance.add(100)
      balance.add(-150)
      balance.add(25)

      setTimeout(() => {
        validator()
        done()
      }, 150)
    })

    it('handles histogram with various bucket distributions', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const exportedMetrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        const histogram = exportedMetrics.find(m => m.name === 'latency')
        
        assert(histogram, 'Histogram should be present')
        assert(histogram.histogram)
        
        const dp = histogram.histogram.dataPoints[0]
        assert(Array.isArray(dp.bucketCounts), 'Should have bucket counts')
        assert(Array.isArray(dp.explicitBounds), 'Should have explicit bounds')
        assert(dp.count > 0, 'Should have recorded values')
        assert(dp.sum > 0, 'Should have sum')
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('app')
      const latency = meter.createHistogram('latency', { unit: 'ms' })
      
      // Record values across different ranges
      latency.record(5)
      latency.record(50)
      latency.record(250)
      latency.record(1000)
      latency.record(5000)

      setTimeout(() => {
        validator()
        done()
      }, 150)
    })

    it('exports instrumentation scope information', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const scopeMetrics = decoded.resourceMetrics[0].scopeMetrics[0]
        
        assert(scopeMetrics.scope, 'Should have scope information')
        assert.strictEqual(scopeMetrics.scope.name, 'instrumented-service')
        assert.strictEqual(scopeMetrics.scope.version, '3.0.0')
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('instrumented-service', '3.0.0')
      const counter = meter.createCounter('test')
      counter.add(1)

      setTimeout(() => {
        validator()
        done()
      }, 150)
    })

    it('handles metrics with no recorded data gracefully', (done) => {
      // When no data is recorded, exports may not happen
      // This test just verifies the system doesn't crash
      initializeOpenTelemetryMetrics(mockConfig())
      
      // Create instruments but don't record anything
      const meter = metrics.getMeter('app')
      meter.createCounter('unused.counter')
      meter.createHistogram('unused.histogram')

      setTimeout(() => {
        // No export expected, just verify no crash
        done()
      }, 150)
    })

    it('supports observable counter instruments', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const exportedMetrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        const counter = exportedMetrics.find(m => m.name === 'active.connections')
        
        assert(counter, 'Observable counter should be exported')
        assert(counter.gauge) // Observable counters are exported as gauges
        assert(counter.gauge.dataPoints.length > 0)
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('app')
      const connections = meter.createObservableCounter('active.connections')
      
      connections.addCallback((result) => {
        result.observe(42)
      })

      setTimeout(() => {
        validator()
        done()
      }, 150)
    })

    it('supports observable updowncounter instruments', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const exportedMetrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        const updown = exportedMetrics.find(m => m.name === 'pending.tasks')
        
        assert(updown, 'Observable updowncounter should be exported')
        assert(updown.gauge)
        assert(updown.gauge.dataPoints.length > 0)
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('app')
      const tasks = meter.createObservableUpDownCounter('pending.tasks')
      
      tasks.addCallback((result) => {
        result.observe(15)
      })

      setTimeout(() => {
        validator()
        done()
      }, 150)
    })

    it('returns no-op meter after shutdown', async () => {
      initializeOpenTelemetryMetrics(mockConfig())
      
      const provider = metrics.getMeterProvider()
      await provider.shutdown()
      
      // Get meter after shutdown
      const meter = metrics.getMeter('post-shutdown-meter')
      
      // Verify all methods exist and are no-ops
      assert(typeof meter.createCounter === 'function')
      assert(typeof meter.createHistogram === 'function')
      assert(typeof meter.createUpDownCounter === 'function')
      assert(typeof meter.createObservableGauge === 'function')
      
      // These should not throw
      const counter = meter.createCounter('test')
      counter.add(1)
      
      const histogram = meter.createHistogram('test')
      histogram.record(1)
    })

    it('handles forceFlush correctly', async () => {
      const validator = mockOtlpExport((decoded) => {
        assert(decoded.resourceMetrics)
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('app')
      const counter = meter.createCounter('test')
      counter.add(1)

      // Force flush immediately
      const provider = metrics.getMeterProvider()
      await provider.forceFlush()

      validator()
    })

    it('handles shutdown gracefully', async () => {
      initializeOpenTelemetryMetrics(mockConfig())
      const provider = metrics.getMeterProvider()
      
      // Shutdown should complete without error
      await provider.shutdown()
      
      // Second shutdown should be safe
      await provider.shutdown()
    })

    it('calls all no-op methods after shutdown', async () => {
      initializeOpenTelemetryMetrics(mockConfig())
      const provider = metrics.getMeterProvider()
      await provider.shutdown()
      
      // Get no-op meter
      const meter = metrics.getMeter('test')
      
      // Exercise all no-op methods
      const counter = meter.createCounter('test')
      counter.add(1)
      
      const updown = meter.createUpDownCounter('test')
      updown.add(-1)
      
      const histogram = meter.createHistogram('test')
      histogram.record(1)
      
      const gauge = meter.createObservableGauge('test')
      gauge.addCallback(() => {})
      
      const obsCounter = meter.createObservableCounter('test')
      obsCounter.addCallback(() => {})
      
      const obsUpdown = meter.createObservableUpDownCounter('test')
      obsUpdown.addCallback(() => {})
      
      // None of these should throw
      assert(true)
    })
  })
})
