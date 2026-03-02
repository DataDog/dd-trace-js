'use strict'

const factory = require('./packages/datadog-unplugin/index.js').webpack

/**
 * Webpack plugin for dd-trace instrumentation.
 * Usage: `plugins: [new DatadogPlugin()]` in webpack.config.js
 */
class DatadogWebpackPlugin {
  /**
   * @param {object} [options] - plugin options (currently unused, reserved for future use)
   */
  constructor (options) {
    this.options = options
  }

  /**
   * @param {object} compiler - the webpack compiler instance
   */
  apply (compiler) {
    factory(this.options).apply(compiler)
  }
}

module.exports = DatadogWebpackPlugin
