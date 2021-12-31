'use strict'

const { id, zeroId } = require('../../id')

const { AUTO_KEEP, AUTO_REJECT, USER_KEEP } = require('../../constants')
const { Trace } = require('../../trace')

const traceKey = 'x-b3-traceid'
const traceExpr = /^([0-9a-f]{16}){1,2}$/i
const spanKey = 'x-b3-spanid'
const spanExpr = /^[0-9a-f]{16}$/i
const parentKey = 'x-b3-parentspanid'
const sampledKey = 'x-b3-sampled'
const flagsKey = 'x-b3-flags'
const headerKey = 'b3'
const headerExpr = /^(([0-9a-f]{16}){1,2}-[0-9a-f]{16}(-[01d](-[0-9a-f]{16})?)?|[01d])$/i

class B3Propagator {
  inject (span, carrier) {
    carrier[traceKey] = span.trace.traceId.toString(16)
    carrier[spanKey] = span.spanId.toString(16)
    carrier[sampledKey] = span.trace.samplingPriority > 0 ? '1' : '0'

    if (span.trace.samplingPriority > 1) {
      carrier[flagsKey] = '1' // debug flag means force trace
    }

    const parentId = span.parentId.toString()

    if (parentId !== '0') {
      carrier[parentKey] = parentId
    }
  }

  extract (carrier) {
    if (headerExpr.test(carrier[headerKey])) {
      carrier = this._extractSingleHeader(carrier)
    }

    if (traceExpr.test(carrier[traceKey]) && spanExpr.test(carrier[spanKey])) {
      const traceId = id(carrier[traceKey], 16)
      const spanId = id(carrier[spanKey], 16)
      const samplingPriority = this._extractSamplingPriority(carrier)

      return {
        trace: new Trace({
          traceId,
          samplingPriority
        }),
        spanId,
        parentId: zeroId,
        baggage: {}
      }
    } else if (carrier[sampledKey] || carrier[flagsKey]) {
      const samplingPriority = this._extractSamplingPriority(carrier)

      return {
        trace: new Trace({
          samplingPriority
        }),
        spanId: id(),
        parentId: zeroId,
        baggage: {}
      }
    }

    return null
  }

  _extractSingleHeader (carrier) {
    const parts = carrier[headerKey].split('-')

    if (parts[0] === 'd') {
      return {
        [sampledKey]: '1',
        [flagsKey]: '1'
      }
    } else if (parts.length === 1) {
      return {
        [sampledKey]: parts[0]
      }
    } else {
      const b3 = {
        [traceKey]: parts[0],
        [spanKey]: parts[1],
        [sampledKey]: parts[2] !== '0' ? '1' : '0'
      }

      if (parts[2] === 'd') {
        b3[flagsKey] = '1'
      }

      return b3
    }
  }

  _extractSamplingPriority (carrier) {
    if (carrier[flagsKey] === '1') {
      return USER_KEEP
    } else if (carrier[sampledKey] === '1') {
      return AUTO_KEEP
    } else if (carrier[sampledKey] === '0') {
      return AUTO_REJECT
    }
  }
}

module.exports = { B3Propagator }
