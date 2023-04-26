'use strict'

module.exports = {
  entry: './index-src.js',
  output: {
    filename: './index.js',
    path: __dirname
  },
  target: 'node',
  mode: 'production'
}
