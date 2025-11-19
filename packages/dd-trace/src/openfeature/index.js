'use strict'

const log = require('../log')
const ExposuresWriter = require('./writers/exposures')
const { setAgentStrategy } = require('./writers/util')
const { channel } = require('dc-polyfill')

const exposureSubmitCh = channel('ffe:exposure:submit')
const flushCh = channel('ffe:writers:flush')

let exposuresWriter = null

/**
 * @private
 * @param {Object|Array<Object>} exposureEvents - Exposure events channel subscriber
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
    log.warn(exposuresWriter.constructor.name + ' already enabled')
    return
  }

  exposuresWriter = new ExposuresWriter(config)
  exposureSubmitCh.subscribe(_handleExposureSubmit)
  flushCh.subscribe(_handleFlush)

  setAgentStrategy(config, hasAgent => {
    exposuresWriter?.setEnabled(hasAgent)
  })

  log.debug('OpenFeature module enabled')
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
  disable
}
