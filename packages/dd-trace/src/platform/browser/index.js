'use strict'

const id = require('./id')
const uuid = require('./uuid')
const now = require('./now')
const env = require('./env')
const validate = require('./validate')
const service = require('./service')
const metrics = require('./metrics')
const Uint64BE = require('../node/uint64be')
const Bowser = require('bowser')
const Instrumenter = require('./instrumenter')
const Scope = require('../../scope/base')
const Exporter = require('../../exporters/log')

const process = Bowser.parse(window.navigator.userAgent)

const platform = {
  _config: {},
  // TODO: distinguish the language/browser
  // TODO: normalize casing
  name: () => process.browsername,
  version: () => process.browser.version,
  engine: () => process.engine.name,
  configure (config) {
    this._config = config
  },
  runtime () {
    return {
      id: () => {
        return this._config._runtimeId || (this._config._runtimeId = this.uuid())
      }
    }
  },
  id,
  uuid,
  now,
  env,
  validate,
  service,
  metrics,
  Uint64BE, // TODO: remove dependency on Uint64BE
  hostname: () => {}, // TODO: add hostname
  on: () => {}, // TODO: add event listener
  off: () => {}, // TODO: add event listener
  Instrumenter,
  Scope,
  Exporter
}

module.exports = platform
