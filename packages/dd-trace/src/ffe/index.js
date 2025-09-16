'use strict'

// TODO: Implement FFE storage mechanism
class FFE {
  constructor () {
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
    return this.ufc // Return all configs if no configId provided
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

// Create a singleton instance
let ffe

module.exports = {
  enable (config) {
    ffe = new FFE()
    return ffe
  },
  disable () {
    ffe = null
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
  }
}
