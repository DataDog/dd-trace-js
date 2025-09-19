'use strict'

const log = require('../log')
const ExposuresWriter = require('./writers/exposures')
const { setAgentStrategy } = require('./writers/util')
const { channel } = require('dc-polyfill')

// FFE diagnostic channels for publishing exposure events
const exposureSubmitCh = channel('ffe:exposure:submit')
const flushCh = channel('ffe:writers:flush')

let exposuresWriter = null
let ffe = null

class FFE {
  constructor (config) {
    this.config = config
    this.ufc = {}
  }

  setConfig (configId, ufcData) {
    // TODO: Implement
    this.ufc[configId] = ufcData
  }

  getConfig (configId) {
    // TODO: Implement
    if (configId) {
      return this.ufc[configId]
    }
    return this.ufc
  }

  modifyConfig (configId, ufcData) {
    // TODO: Implement
    this.ufc[configId] = ufcData
  }

  removeConfig (configId) {
    // TODO: Implement
    delete this.ufc[configId]
  }
}

// subscriber callback for exposure events channel
function _handleExposureSubmit (exposureEvents) {
  if (!exposuresWriter) return

  // Handle single event passed as non-array
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

    // Configure agent strategy asynchronously
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
    if (!ffe) {
      ffe = new FFE(config)
      _setupWriter(config)
    }
    return ffe
  },

  disable () {
    // Clean up resources
    _destroyWriter()

    if (ffe) {
      ffe = null
    }

    log.debug('[FFE] Disabled')
  },

  getConfig (configId) {
    return ffe?.getConfig(configId)
  },

  modifyConfig (configId, ufcData) {
    return ffe?.modifyConfig(configId, ufcData)
  },

  setConfig (configId, ufcData) {
    return ffe?.setConfig(configId, ufcData)
  },

  removeConfig (configId) {
    return ffe?.removeConfig(configId)
  },
}
