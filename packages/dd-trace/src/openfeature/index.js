'use strict'

const log = require('../log')
const ExposuresWriter = require('./writers/exposures')
const { setAgentStrategy } = require('./writers/util')
const { channel } = require('dc-polyfill')

const exposureSubmitCh = channel('ffe:exposure:submit')
const flushCh = channel('ffe:writers:flush')

let exposuresWriter = null

function _handleExposureSubmit (exposureEvents) {
  if (!exposuresWriter) return

  const events = Array.isArray(exposureEvents) ? exposureEvents : [exposureEvents]
  for (const event of events) {
    exposuresWriter.append(event)
  }
}

function _handleFlush () {
  exposuresWriter?.flush()
}

module.exports = {
  enable (config) {
    if (exposuresWriter) {
      log.warn('[FlaggingProvider] Already enabled')
      return
    }

    exposuresWriter = new ExposuresWriter(config)
    exposureSubmitCh.subscribe(_handleExposureSubmit)
    flushCh.subscribe(_handleFlush)

    setAgentStrategy(config, hasAgent => {
      exposuresWriter?.setEnabled(hasAgent)
    })

    log.debug('[FlaggingProvider] Enabled')
  },

  disable () {
    if (!exposuresWriter) return

    if (exposureSubmitCh.hasSubscribers) {
      exposureSubmitCh.unsubscribe(_handleExposureSubmit)
    }
    if (flushCh.hasSubscribers) {
      flushCh.unsubscribe(_handleFlush)
    }

    exposuresWriter.destroy?.()
    exposuresWriter = null

    log.debug('[FlaggingProvider] Disabled')
  }
}
