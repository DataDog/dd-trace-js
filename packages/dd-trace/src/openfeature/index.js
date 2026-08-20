'use strict'

const { channel } = require('dc-polyfill')
const log = require('../log')
const ExposuresWriter = require('./writers/exposures')
const { setAgentStrategy } = require('./writers/util')

const exposureSubmitCh = channel('ffe:exposure:submit')
const flushCh = channel('ffe:writers:flush')

let exposuresWriter = null

/**
 * @private
 * @param {object | Array<object>} exposureEvents - Exposure events channel subscriber
 * @returns {void}
 */
function _handleExposureSubmit (exposureEvents) {
  if (!exposuresWriter) return
  exposuresWriter.append(exposureEvents)
}

/**
 * Channel subscriber for manually flushing the exposures writer
 * @private
 * @returns {void}
 */
function _handleFlush () {
  exposuresWriter?.flush()
}

/**
 * Enables the OpenFeature module and sets up FF&E writer and channel subscribers
 * @param {import('../config')} config - Tracer configuration object
 * @returns {void}
 */
function enable (config) {
  if (exposuresWriter) {
    log.warn('%s already enabled', exposuresWriter.constructor.name)
    return
  }

  try {
    exposuresWriter = new ExposuresWriter(config)
  } catch (error) {
    log.error('Unable to configure OpenFeature exposure delivery: %s', error.message)
    return
  }

  exposureSubmitCh.subscribe(_handleExposureSubmit)
  flushCh.subscribe(_handleFlush)

  if (config.DD_AGENTLESS_ENABLED) {
    exposuresWriter.setEnabled(true)
    return
  }

  setAgentStrategy(config, hasAgent => {
    exposuresWriter?.setEnabled(hasAgent)
  })
}

/**
 * Disables the OpenFeature module and cleans up resources
 * @returns {void}
 */
function disable () {
  if (!exposuresWriter) return

  if (exposureSubmitCh.hasSubscribers) {
    exposureSubmitCh.unsubscribe(_handleExposureSubmit)
  }
  if (flushCh.hasSubscribers) {
    flushCh.unsubscribe(_handleFlush)
  }

  exposuresWriter.destroy?.()
  exposuresWriter = null

  log.debug('OpenFeature module disabled')
}

module.exports = {
  enable,
  disable,
}
