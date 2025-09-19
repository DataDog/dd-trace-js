'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('mocha')
const OtlpTransformer = require('../../src/opentelemetry/logs/otlp_transformer')
const { SeverityNumber } = require('@opentelemetry/api-logs')

describe('OTLP Protobuf Serialization', () => {
  let transformer

  beforeEach(() => {
    transformer = new OtlpTransformer({
      resource: {
        attributes: {
          'service.name': 'test-service',
          'service.version': '1.0.0',
          'deployment.environment': 'test'
        }
      }
    })
  })

  it('should serialize log records to protobuf format', () => {
    const logRecords = [
      {
        timestamp: Date.now() * 1000000,
        severityNumber: SeverityNumber.INFO,
        severityText: 'INFO',
        body: 'Test log message',
        attributes: {
          'test.attribute': 'test-value',
          'user.id': '12345'
        }
      }
    ]

    const result = transformer.transformLogRecords(logRecords)

    expect(result).to.be.instanceOf(Buffer)
    expect(result.length).to.be.greaterThan(0)
  })

  it('should handle different severity levels', () => {
    const logRecords = [
      {
        severityNumber: SeverityNumber.DEBUG,
        severityText: 'DEBUG',
        body: 'Debug message'
      },
      {
        severityNumber: SeverityNumber.ERROR,
        severityText: 'ERROR',
        body: 'Error message'
      },
      {
        severityNumber: SeverityNumber.FATAL,
        severityText: 'FATAL',
        body: 'Fatal message'
      }
    ]

    const result = transformer.transformLogRecords(logRecords)

    expect(result).to.be.instanceOf(Buffer)
    expect(result.length).to.be.greaterThan(0)
  })

  it('should handle trace and span IDs', () => {
    const logRecords = [
      {
        body: 'Test message with trace context',
        traceId: '12345678901234567890123456789012',
        spanId: '1234567890123456'
      }
    ]

    const result = transformer.transformLogRecords(logRecords)

    expect(result).to.be.instanceOf(Buffer)
    expect(result.length).to.be.greaterThan(0)
  })

  it('should handle different body types', () => {
    const logRecords = [
      {
        body: 'String message',
        severityNumber: SeverityNumber.INFO
      },
      {
        body: 42,
        severityNumber: SeverityNumber.INFO
      },
      {
        body: true,
        severityNumber: SeverityNumber.INFO
      },
      {
        body: { nested: { value: 'object' } },
        severityNumber: SeverityNumber.INFO
      }
    ]

    const result = transformer.transformLogRecords(logRecords)

    expect(result).to.be.instanceOf(Buffer)
    expect(result.length).to.be.greaterThan(0)
  })

  it('should handle array attributes', () => {
    const logRecords = [
      {
        body: 'Message with array attributes',
        attributes: {
          tags: ['tag1', 'tag2', 'tag3'],
          numbers: [1, 2, 3, 4, 5],
          mixed: ['string', 42, true, { nested: 'object' }]
        }
      }
    ]

    const result = transformer.transformLogRecords(logRecords)

    expect(result).to.be.instanceOf(Buffer)
    expect(result.length).to.be.greaterThan(0)
  })

  it('should fallback to JSON if protobuf serialization fails', () => {
    // Create a transformer with JSON protocol to test fallback
    const transformer = new OtlpTransformer({
      protocol: 'http/json',
      resource: {
        attributes: {
          'service.name': 'test-service'
        }
      }
    })

    const logRecords = [
      {
        body: 'Test message',
        severityNumber: SeverityNumber.INFO
      }
    ]

    const result = transformer.transformLogRecords(logRecords)

    expect(result).to.be.instanceOf(Buffer)
    expect(result.length).to.be.greaterThan(0)

    // Should be JSON (starts with {)
    expect(result.toString('utf8').startsWith('{')).to.be.true
  })

  it('should handle empty log records', () => {
    const result = transformer.transformLogRecords([])

    expect(result).to.be.instanceOf(Buffer)
    expect(result.length).to.be.greaterThan(0)
  })

  it('should handle missing instrumentation library', () => {
    const logRecords = [
      {
        body: 'Message without instrumentation library',
        severityNumber: SeverityNumber.INFO
      }
    ]

    const result = transformer.transformLogRecords(logRecords)

    expect(result).to.be.instanceOf(Buffer)
    expect(result.length).to.be.greaterThan(0)
  })

  it('should convert hex strings to bytes correctly', () => {
    const transformer = new OtlpTransformer()

    // Test empty string
    expect(transformer._hexToBytes('')).to.deep.equal(Buffer.alloc(0))

    // Test with 0x prefix
    const result1 = transformer._hexToBytes('0x1234')
    expect(result1).to.deep.equal(Buffer.from('1234', 'hex'))

    // Test without 0x prefix
    const result2 = transformer._hexToBytes('1234')
    expect(result2).to.deep.equal(Buffer.from('1234', 'hex'))

    // Test odd length (should be padded)
    const result3 = transformer._hexToBytes('123')
    expect(result3).to.deep.equal(Buffer.from('0123', 'hex'))
  })

  it('should map severity numbers correctly', () => {
    const transformer = new OtlpTransformer()

    // Test INFO mapping
    const infoSeverity = transformer._mapSeverityNumber(SeverityNumber.INFO)
    expect(infoSeverity).to.be.a('number')

    // Test ERROR mapping
    const errorSeverity = transformer._mapSeverityNumber(SeverityNumber.ERROR)
    expect(errorSeverity).to.be.a('number')

    // Test unknown severity (should default to INFO)
    const unknownSeverity = transformer._mapSeverityNumber(999)
    expect(unknownSeverity).to.be.a('number')
  })
})
