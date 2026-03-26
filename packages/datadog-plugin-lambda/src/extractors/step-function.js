'use strict'

const log = require('../../../dd-trace/src/log')

function extractStateMachineContext (event) {
  if (
    typeof event?.Execution?.Id === 'string' &&
    typeof event?.State?.EnteredTime === 'string' &&
    typeof event?.State?.Name === 'string'
  ) {
    return {
      executionId: event.Execution.Id,
      redriveCount: (event.Execution.RedriveCount ?? '0').toString(),
      retryCount: (event.State.RetryCount ?? '0').toString(),
      stateEnteredTime: event.State.EnteredTime,
      stateName: event.State.Name
    }
  }
  return null
}

function resolveStepFunctionEvent (event) {
  if (typeof event !== 'object' || event === null) return null

  let ev = event
  if (typeof ev.Payload === 'object' && ev.Payload !== null) {
    if (typeof ev.Payload._datadog === 'object' || (
      typeof ev.Payload?.Execution?.Id === 'string' &&
      typeof ev.Payload?.State?.EnteredTime === 'string' &&
      typeof ev.Payload?.State?.Name === 'string'
    )) {
      ev = ev.Payload
    }
  }
  if (typeof ev._datadog === 'object') {
    ev = ev._datadog
  }
  return ev
}

function deterministicSha256Hash (input, type) {
  try {
    const { createHash } = require('crypto')
    const hash = createHash('sha256')
    hash.update(input)
    const digest = hash.digest()

    let intArray
    if (type === 'traceId') {
      intArray = digest.subarray(8, 16)
    } else {
      intArray = digest.subarray(0, 8)
    }

    let binaryString = ''
    for (const num of intArray) {
      binaryString += num.toString(2).padStart(8, '0')
    }

    const res = '0' + binaryString.substring(1, 64)
    if (res === '0'.repeat(64)) {
      return '1'
    }
    return res
  } catch (error) {
    log.debug('Failed to compute SHA-256 hash: %s', error.message)
    return '1'
  }
}

function deterministicSha256HashToBigIntString (input, type) {
  const binaryString = deterministicSha256Hash(input, type)
  return BigInt('0b' + binaryString).toString()
}

function parsePTid (traceTags) {
  if (traceTags) {
    for (const tag of traceTags.split(',')) {
      if (tag.includes('_dd.p.tid=')) {
        return tag.split('=')[1]
      }
    }
  }
  return ''
}

function extract (event) {
  try {
    const ev = resolveStepFunctionEvent(event)
    if (!ev) return null

    const smContext = extractStateMachineContext(ev)
    if (!smContext) return null

    const isV1 = typeof ev['serverless-version'] === 'string' && ev['serverless-version'] === 'v1'

    let traceId
    let ptid

    if (isV1 && typeof ev.RootExecutionId === 'string') {
      traceId = deterministicSha256HashToBigIntString(ev.RootExecutionId, 'traceId')
      ptid = deterministicSha256HashToBigIntString(ev.RootExecutionId, '_dd.p.tid')
    } else if (isV1 && typeof ev['x-datadog-trace-id'] === 'string' && typeof ev['x-datadog-tags'] === 'string') {
      traceId = ev['x-datadog-trace-id']
      ptid = parsePTid(ev['x-datadog-tags'])
    } else {
      traceId = deterministicSha256HashToBigIntString(smContext.executionId, 'traceId')
      ptid = deterministicSha256HashToBigIntString(smContext.executionId, '_dd.p.tid')
    }

    const countsSuffix =
      smContext.retryCount !== '0' || smContext.redriveCount !== '0'
        ? '#' + smContext.retryCount + '#' + smContext.redriveCount
        : ''

    const parentId = deterministicSha256HashToBigIntString(
      smContext.executionId + '#' + smContext.stateName + '#' + smContext.stateEnteredTime + countsSuffix,
      'spanId'
    )

    try {
      const DatadogSpanContext = require('../../../dd-trace/src/opentracing/span_context')
      const id = require('../../../dd-trace/src/id')

      const spanContext = new DatadogSpanContext({
        traceId: id(traceId, 10),
        spanId: id(parentId, 10),
        sampling: { priority: 1 }
      })

      spanContext._trace.tags['_dd.p.tid'] = id(ptid, 10).toString(16)

      log.debug('Extracted trace context from Step Function event')
      return spanContext
    } catch (error) {
      log.debug('Could not generate SpanContext with tracer: %s', error.message)
      return null
    }
  } catch (error) {
    log.debug('Unable to extract trace context from Step Function event: %s', error.message)
  }

  return null
}

module.exports = {
  extract,
  extractStateMachineContext,
  resolveStepFunctionEvent,
  deterministicSha256HashToBigIntString
}
