'use strict'

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
  }
]
