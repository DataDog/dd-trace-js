'use strict'

const crypto = require('./crypto')
const now = require('./now')
const env = require('./env')
const validate = require('./validate')
const service = require('./service')
const metrics = require('./metrics')
const plugins = require('../../plugins/browser')
const Bowser = require('bowser')
const Loader = require('./loader')
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
  plugins,
  hostname: () => {}, // TODO: add hostname
  on: () => {}, // TODO: add event listener
  off: () => {}, // TODO: add event listener
  Loader,
  Scope,
  Exporter
}

module.exports = platform
