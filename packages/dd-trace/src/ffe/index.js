'use strict'

const log = require('../log')
const ExposuresWriter = require('./writers/exposures')
const { setAgentStrategy } = require('./writers/util')
const { channel } = require('dc-polyfill')

// FlaggingProvider diagnostic channels for publishing exposure events
const exposureSubmitCh = channel('ffe:exposure:submit')
const flushCh = channel('ffe:writers:flush')

let exposuresWriter = null

// subscriber callback for exposure events channel
function _handleExposureSubmit (exposureEvents) {
  if (!exposuresWriter) return

  const events = Array.isArray(exposureEvents) ? exposureEvents : [exposureEvents]
  events.forEach(event => {
    exposuresWriter.append(event)
  })
}

// subscriber callback for flush channel, triggers a manual flush, otherwise writer flushes periodically
function _handleFlush () {
  if (exposuresWriter) {
    exposuresWriter.flush()
  }
}

function _setupWriter (config) {
  // Unsubscribe from channels
  if (exposureSubmitCh.hasSubscribers) exposureSubmitCh.unsubscribe(_handleExposureSubmit)
  if (flushCh.hasSubscribers) flushCh.unsubscribe(_handleFlush)
  // Create writer immediately
  if (!exposuresWriter) {
    exposuresWriter = new ExposuresWriter(config)

    // Subscribe to channels immediately
    exposureSubmitCh.subscribe(_handleExposureSubmit)
    flushCh.subscribe(_handleFlush)

    setAgentStrategy(config, hasAgent => {
      if (exposuresWriter) {
        exposuresWriter.setEnabled(hasAgent)
      }
    })
  }
}

function _destroyWriter () {
  if (exposuresWriter) {
    exposuresWriter.destroy?.()
    exposuresWriter = null
  }
}

module.exports = {
  enable (config) {
    _setupWriter(config)
    log.debug('[FlaggingProvider] Enabled')
  },

  disable () {
    // Clean up resources
    _destroyWriter()
    log.debug('[FlaggingProvider] Disabled')
  },
}
