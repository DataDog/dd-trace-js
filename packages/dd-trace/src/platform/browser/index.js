'use strict'

const crypto = require('./crypto')
const now = require('./now')
const env = require('./env')
const tags = require('./tags')
const validate = require('./validate')
const service = require('./service')
const metrics = require('./metrics')
const plugins = require('../../plugins/browser')
const Loader = require('./loader')
const Scope = require('../../scope/zone')
const Exporter = require('../../exporters/browser')

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
