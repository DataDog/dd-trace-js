'use strict'

module.exports = {
  ...require('./cache'),
  ...require('./configuration')
}

// Build environment placeholder for testing - will be set during build
const _SDK_VERSION = process.env.npm_package_version || '0.0.0'