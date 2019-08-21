'use strict'

const crypto = require('./crypto')
const now = require('./now')
const env = require('./env')
const validate = require('./validate')
const service = require('./service')
const metrics = require('./metrics')
const Bowser = require('bowser')
const Instrumenter = require('./instrumenter')
const Scope = require('../../scope/base')
const Exporter = require('../../exporters/log')

const process = Bowser.parse(window.navigator.userAgent)

const platform = {
  _config: {},
  // TODO: distinguish the language/browser
  // TODO: normalize casing
  name: () => process.browser.name,
  version: () => process.browser.version,
  engine: () => process.engine.name,
  crypto,
  now,
  env,
  validate,
  service,
  metrics,
  hostname: () => {}, // TODO: add hostname
  on: () => {}, // TODO: add event listener
  off: () => {}, // TODO: add event listener
  Instrumenter,
  Scope,
  Exporter
}

module.exports = platform
