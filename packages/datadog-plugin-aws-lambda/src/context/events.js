'use strict'

const log = require('../../../dd-trace/src/log')

/** @typedef {import('../../../dd-trace/src/opentracing/span_context')} SpanContext */
/** @typedef {import('../../../dd-trace/src/opentracing/tracer')} Tracer */

/**
 * @param {Record<string, unknown>|undefined} record SNS record.
 * @returns {Record<string, string>|null}
 */
function getSNSHeaders (record) {
  try {
    const attribute = record?.Sns?.MessageAttributes?._datadog
    if (!attribute?.Value) return null
    const value = attribute.Type === 'String'
      ? attribute.Value
      : Buffer.from(attribute.Value, 'base64').toString('ascii')
    return JSON.parse(value)
  } catch {
    return null
  }
}

/**
 * @param {Record<string, unknown>|undefined} record SNS-over-SQS record.
 * @returns {Record<string, string>|null}
 */
function getSNSSQSHeaders (record) {
  if (!record) return null
  try {
    if (record.body) {
      const body = JSON.parse(record.body)
      const attribute = body?.MessageAttributes?._datadog
      if (attribute?.Value) {
        const value = attribute.Type === 'String'
          ? attribute.Value
          : Buffer.from(attribute.Value, 'base64').toString('ascii')
        return JSON.parse(value)
      }
    }
    const attribute = record.messageAttributes?._datadog
    return attribute?.stringValue ? JSON.parse(attribute.stringValue) : null
  } catch {
    return null
  }
}

/**
 * @param {Record<string, unknown>|undefined} record SQS record.
 * @returns {Record<string, string>|null}
 */
function getSQSHeaders (record) {
  try {
    let headers = record?.messageAttributes?._datadog?.stringValue
    if (!headers) {
      const encoded = record?.messageAttributes?._datadog?.binaryValue
      if (encoded) headers = Buffer.from(encoded, 'base64').toString('ascii')
    }
    return headers ? JSON.parse(headers) : null
  } catch {
    return null
  }
}

/**
 * @param {Record<string, unknown>|undefined} record EventBridge-over-SQS record.
 * @returns {Record<string, string>|null}
 */
function getEventBridgeSQSHeaders (record) {
  try {
    return record?.body ? JSON.parse(record.body)?.detail?._datadog ?? null : null
  } catch {
    return null
  }
}

/**
 * @param {Record<string, unknown>} event Kinesis event.
 * @param {Tracer} tracer Core tracer.
 * @returns {SpanContext|null}
 */
function extractKinesis (event, tracer) {
  const data = event?.Records?.[0]?.kinesis.data
  if (data === undefined) return null
  try {
    if (!data) return null
    const headers = JSON.parse(Buffer.from(data, 'base64').toString('ascii'))?._datadog
    return headers ? tracer.extract('text_map', headers) : null
  } catch (error) {
    log.debug('Unable to extract trace context from Kinesis event: %s', error)
    return null
  }
}

/**
 * @param {Record<string, unknown>} event MSK event.
 * @param {Tracer} tracer Core tracer.
 * @returns {SpanContext|null}
 */
function extractMSK (event, tracer) {
  if (!event?.records) return null
  // Unlike SQS/SNS/Kinesis, MSK selects the first traced record across partitions.
  for (const records of Object.values(event.records)) {
    if (!Array.isArray(records)) continue
    for (const record of records) {
      try {
        if (!Array.isArray(record?.headers)) continue
        let headers = null
        for (const entry of record.headers) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
          for (const [name, value] of Object.entries(entry)) {
            if (Array.isArray(value)) {
              headers ??= {}
              headers[name.toLowerCase()] = Buffer.from(value).toString('utf8')
            }
          }
        }
        if (!headers) continue
        const context = tracer.extract('text_map', headers)
        if (context) return context
      } catch (error) {
        log.debug('Unable to extract trace context from MSK event: %s', error)
      }
    }
  }
  return null
}

/**
 * @param {Record<string, unknown>} event Durable Execution event.
 * @param {Tracer} tracer Core tracer.
 * @returns {SpanContext|null}
 */
function extractDurableExecution (event, tracer) {
  if (!event?.DurableExecutionArn) return null
  const operations = event.InitialExecutionState?.Operations
  if (!operations || operations.length === 0) return null
  let best = null
  for (const op of operations) {
    if (typeof op?.Name !== 'string' || !op.Name.startsWith('_datadog_')) continue
    const suffix = op.Name.slice('_datadog_'.length)
    const number = Number.parseInt(suffix, 10)
    if (Number.isNaN(number) || String(number) !== suffix) continue
    if (best === null || number > best.number) best = { number, op }
  }
  if (best === null) return null
  const raw = best.op.Payload ?? best.op.StepDetails?.Result
  if (!raw || typeof raw !== 'string') return null
  let headers
  try {
    headers = JSON.parse(raw)
  } catch (error) {
    log.debug('Failed to parse trace checkpoint payload: %s', error)
  }
  return headers && typeof headers === 'object' ? tracer.extract('text_map', headers) : null
}

module.exports = {
  getSNSHeaders,
  getSNSSQSHeaders,
  getSQSHeaders,
  getEventBridgeSQSHeaders,
  extractKinesis,
  extractMSK,
  extractDurableExecution,
}
