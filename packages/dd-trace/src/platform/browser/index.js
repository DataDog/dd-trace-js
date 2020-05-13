'use strict'

const crypto = require('./crypto')
const now = require('./now')
const env = require('./env')
const tags = require('./tags')
const validate = require('./validate')
const metrics = require('./metrics')
const plugins = require('../../plugins/browser')
const exporter = require('./exporter')
const Loader = require('./loader')
const Scope = require('../../scope/zone')

const platform = {
  _config: {},
  // TODO: determine what should be the name/version/engine
  name: () => {},
  version: () => {},
  engine: () => {},
  crypto,
  now,
  env,
  tags,
  validate,
  service: () => 'browser',
  appVersion: () => null,
  metrics,
  plugins,
  hostname: () => {}, // TODO: add hostname
  on: () => {}, // TODO: add event listener
  off: () => {}, // TODO: add event listener
  Loader,
  getScope: () => Scope,
  exporter
}

module.exports = platform
