'use strict'

const { join } = require('path')
const pkg = require('./package.json')

const names = Object.keys(pkg.dependencies).concat([
  'retry/lib/retry_operation',
  'source-map/lib/util'
])

module.exports = {
  entry: Object.fromEntries(names.map(name => [name, `./node_modules/${name}`])),
  target: 'node',
  mode: 'production',
  devtool: false,
  output: {
    filename: '[name].js',
    libraryTarget: 'commonjs2',
    path: join(__dirname, '..', 'packages', 'node_modules'),
    clean: true
  },
}
