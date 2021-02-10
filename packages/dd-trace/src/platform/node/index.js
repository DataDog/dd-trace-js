'use strict'

const validate = require('./validate')
const pkg = require('./pkg')

const platform = {
  _config: {},
  configure (config) {
    this._config = config
  },
  validate,
  service: () => process.env['AWS_LAMBDA_FUNCTION_NAME'] || pkg.name,
  appVersion: () => pkg.version
}

module.exports = platform
