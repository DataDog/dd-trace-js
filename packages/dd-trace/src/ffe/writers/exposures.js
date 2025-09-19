'use strict'

const BaseFFEWriter = require('./base')
const { EXPOSURES_ENDPOINT, EXPOSURES_INTAKE } = require('../constants/writers')

class ExposuresWriter extends BaseFFEWriter {
  constructor (config) {
    super({
      config,
      endpoint: EXPOSURES_ENDPOINT,
      intake: EXPOSURES_INTAKE,
      interval: config.ffeFlushInterval,
      timeout: config.ffeTimeout
    })
    this._enabled = false // Start disabled until agent strategy is set
    this._pendingEvents = [] // Buffer events until enabled
  }

  setEnabled (enabled) {
    this._enabled = enabled

    if (enabled && this._pendingEvents.length > 0) {
      // Flush pending events when enabled
      this._pendingEvents.forEach(({ event, byteLength }) => {
        super.append(event, byteLength)
      })
      this._pendingEvents = []
    }
  }

  append (event, byteLength) {
    if (!this._enabled) {
      // Buffer events when disabled until writer is ready
      this._pendingEvents.push({ event, byteLength })
      return
    }
    super.append(event, byteLength)
  }

  flush () {
    if (!this._enabled) {
      // Don't flush when disabled
      return
    }
    super.flush()
  }

  makePayload (events) {
    // Agent expects raw exposure events conforming to exposures schema
    // No SDK wrapper needed - agent forwards JSON directly to intake
    return events.map(event => this._formatExposureEvent(event))
  }

  // export interface ExposureEvent {
  //   /** Unix timestamp in milliseconds */
  //   timestamp: number
  //   allocation: {
  //     key: string
  //   }
  //   flag: {
  //     key: string
  //   }
  //   variant: {
  //     key: string
  //   }
  //   subject: {
  //     id: string
  //     attributes: EvaluationContext
  //   }
  // }
  _formatExposureEvent (event) {
    // Ensure the event matches the expected schema
    const formattedEvent = {
      timestamp: event.timestamp || Date.now(),
      allocation: {
        key: event.allocation?.key || event['allocation.key']
      },
      flag: {
        key: event.flag?.key || event['flag.key']
      },
      variant: {
        key: event.variant?.key || event['variant.key']
      },
      subject: {
        id: event.subject?.id || event['subject.id'],
        type: event.subject?.type || 'user', // defaults to 'user'
        attributes: event.subject?.attributes || {}, // defaults to empty
      }
    }
    return formattedEvent
  }
}

module.exports = ExposuresWriter
