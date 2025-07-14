'use strict'

const {
  EVP_EVENT_SIZE_LIMIT,
  EVP_PAYLOAD_SIZE_LIMIT,
  SPANS_ENDPOINT,
  SPANS_EVENT_TYPE,
  SPANS_INTAKE
} = require('../constants/writers')
const { DROPPED_VALUE_TEXT } = require('../constants/text')
const { DROPPED_IO_COLLECTION_ERROR } = require('../constants/tags')
const BaseWriter = require('./base')
const telemetry = require('../telemetry')
const logger = require('../../log')

const tracerVersion = require('../../../../../package.json').version

class LLMObsSpanWriter extends BaseWriter {
  constructor (config) {
    super({
      config,
      eventType: SPANS_EVENT_TYPE,
      intake: SPANS_INTAKE,
      endpoint: SPANS_ENDPOINT
    })
  }

  append (event) {
    const eventSizeBytes = Buffer.byteLength(JSON.stringify(event))
    telemetry.recordLLMObsRawSpanSize(event, eventSizeBytes)

    const shouldTruncate = eventSizeBytes > EVP_EVENT_SIZE_LIMIT
    let processedEventSizeBytes = eventSizeBytes

    if (shouldTruncate) {
      logger.warn(`Dropping event input/output because its size (${eventSizeBytes}) exceeds the 1MB event size limit`)
      event = this._truncateSpanEvent(event)
      processedEventSizeBytes = Buffer.byteLength(JSON.stringify(event))
    }

    telemetry.recordLLMObsSpanSize(event, processedEventSizeBytes, shouldTruncate)

    if (this._bufferSize + eventSizeBytes > EVP_PAYLOAD_SIZE_LIMIT) {
      logger.debug('Flushing queue because queuing next event will exceed EvP payload limit')
      this.flush()
    }

    super.append(event, processedEventSizeBytes)
  }

  makePayload (events) {
    return events.map(event => ({
      '_dd.stage': 'raw',
      '_dd.tracer_version': tracerVersion,
      event_type: this._eventType,
      spans: [event]
    }))
  }

  _truncateSpanEvent (event) {
    event.meta.input = { value: DROPPED_VALUE_TEXT }
    event.meta.output = { value: DROPPED_VALUE_TEXT }

    event.collection_errors = [DROPPED_IO_COLLECTION_ERROR]
    return event
  }
}

module.exports = LLMObsSpanWriter
