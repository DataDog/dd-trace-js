'use strict'

const { EVP_EVENT_SIZE_LIMIT, EVP_PAYLOAD_SIZE_LIMIT } = require('../../constants/writers')
const { DROPPED_VALUE_TEXT } = require('../../constants/text')
const { DROPPED_IO_COLLECTION_ERROR } = require('../../constants/tags')
const BaseWriter = require('../base')
const telemetry = require('../../telemetry')
const logger = require('../../../log')

const tracerVersion = require('../../../../../../package.json').version

class LLMObsSpanWriter extends BaseWriter {
  constructor (options) {
    super({
      ...options,
      eventType: 'span'
    })
  }

  append (event) {
    const eventSizeBytes = Buffer.from(JSON.stringify(event)).byteLength
    telemetry.submitLLMObsRawSpanSize(event, eventSizeBytes)

    let processedEventSizeBytes = eventSizeBytes

    if (eventSizeBytes > EVP_EVENT_SIZE_LIMIT) {
      logger.warn(`Dropping event input/output because its size (${eventSizeBytes}) exceeds the 1MB event size limit`)
      event = this._truncateSpanEvent(event)
      processedEventSizeBytes = Buffer.from(JSON.stringify(event)).byteLength
    }

    telemetry.submitLLMObsSpanSize(event, processedEventSizeBytes)

    if (this._bufferSize + eventSizeBytes > EVP_PAYLOAD_SIZE_LIMIT) {
      logger.debug('Flusing queue because queing next event will exceed EvP payload limit')
      this.flush()
    }

    super.append(event, eventSizeBytes)
  }

  makePayload (events) {
    return {
      '_dd.stage': 'raw',
      '_dd.tracer_version': tracerVersion,
      event_type: this._eventType,
      spans: events
    }
  }

  _truncateSpanEvent (event) {
    event.meta.input = { value: DROPPED_VALUE_TEXT }
    event.meta.output = { value: DROPPED_VALUE_TEXT }

    event.collection_errors = [DROPPED_IO_COLLECTION_ERROR]
    return event
  }
}

module.exports = LLMObsSpanWriter
