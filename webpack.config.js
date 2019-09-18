'use strict'

module.exports = (env) => ({
  mode: 'production',
  devtool: 'source-map',
  entry: {
    'dd-trace': './browser.js'
  },
  output: {
    filename: '[name].min.js'
  },
  stats: {
    assetsSort: '!size',
    chunksSort: '!size',
    modulesSort: '!size'
  },
  node: false
})
