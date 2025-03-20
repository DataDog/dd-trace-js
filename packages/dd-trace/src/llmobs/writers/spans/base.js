'use strict'

const { EVP_EVENT_SIZE_LIMIT, EVP_PAYLOAD_SIZE_LIMIT } = require('../../constants/writers')
const { DROPPED_VALUE_TEXT } = require('../../constants/text')
const { DROPPED_IO_COLLECTION_ERROR } = require('../../constants/tags')
const BaseLLMObsWriter = require('../base')
const logger = require('../../../log')

const tracerVersion = require('../../../../../../package.json').version

class LLMObsSpanWriter extends BaseLLMObsWriter {
  constructor (options) {
    super({
      ...options,
      eventType: 'span'
    })
  }

  /**
   * Appends an LLM Observability span event to the writer's buffer. If the event size exceeds the
   * 1MB limit, the event will be truncated and a warning will be logged.
   * Additionally, if the buffer size exceeds the intake limit, the buffer will be flushed before enqueueing the event.
   * @override
   * @param {*} event - an LLM Observability span event
   */
  append (event) {
    const eventSizeBytes = Buffer.from(JSON.stringify(event)).byteLength
    if (eventSizeBytes > EVP_EVENT_SIZE_LIMIT) {
      logger.warn(`Dropping event input/output because its size (${eventSizeBytes}) exceeds the 1MB event size limit`)
      event = this._truncateSpanEvent(event)
    }

    if (this._bufferSize + eventSizeBytes > EVP_PAYLOAD_SIZE_LIMIT) {
      logger.debug('Flushing queue because queuing next event will exceed EvP payload limit')
      this.flush()
    }

    super.append(event, eventSizeBytes)

    this.makePayload()
  }

  /**
   * Formats the span payload
   * @override
   * @param {*} events - list of LLM Observability span events
   * @returns {Record<string, string | unknown[]>} the formatted payload
   */
  makePayload (events) {
    return {
      '_dd.stage': 'raw',
      '_dd.tracer_version': tracerVersion,
      event_type: this._eventType,
      spans: events
    }
  }

  /**
   * Truncates the input and output values of the LLM Observability span event.
   * Additionally, sets the collection_errors field to indicate that the event was truncated
   * @param {*} event - the LLM Observability span event to truncate
   * @returns {*} the truncated event
   */
  _truncateSpanEvent (event) {
    event.meta.input = { value: DROPPED_VALUE_TEXT }
    event.meta.output = { value: DROPPED_VALUE_TEXT }

    event.collection_errors = [DROPPED_IO_COLLECTION_ERROR]
    return event
  }
}

module.exports = LLMObsSpanWriter
