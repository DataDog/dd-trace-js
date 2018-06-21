'use strict'

const semver = require('semver')

if (process && semver.gte(process.versions.node, '8.0.0')) {
  module.exports = require('./async_hooks')
} else {
  module.exports = require('./async_wrap')
}
