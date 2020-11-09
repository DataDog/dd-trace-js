'use strict'
const nodeExternals = require('webpack-node-externals')

const base = {
  devtool: 'source-map',
  entry: {
    'dd-trace': './browser.js'
  },
  module: {
    rules: [{
      loader: 'babel-loader'
    }]
  },
  stats: {
    assetsSort: '!size',
    chunksSort: '!size',
    modulesSort: '!size'
  },
  node: false
}

module.exports = [
  {
    ...base,
    mode: 'production',
    output: {
      filename: '[name].min.js'
    }
  },
  {
    ...base,
    mode: 'development',
    output: {
      filename: '[name].js'
    }
  },
  {
    devtool: 'source-map',
    mode: 'development',
    entry: './packages/datadog-plugin-jest/src/index.js',
    output: {
      filename: 'testEnvironment.js',
      path: __dirname
    },
    target: 'node',
    externals: [nodeExternals()]
  }
]
