'use strict'

const { createHash } = require('crypto')
const { join } = require('path')
const pkg = require('./package.json')
const { readFileSync } = require('fs')

const hash = createHash('sha256')

hash.update(readFileSync(__filename))

const version = hash.digest('utf8')
const names = Object.keys(pkg.dependencies).concat([
  'retry/lib/retry_operation',
  'source-map/lib/util'
])

module.exports = {
  entry: Object.fromEntries(names.map(name => [name, `./node_modules/${name}`])),
  target: 'node',
  mode: 'production',
  cache: {
    type: 'filesystem',
    version,
  },
  output: {
    filename: '[name].js',
    libraryTarget: 'commonjs2',
    path: join(__dirname, '..', 'packages', 'node_modules'),
    clean: true
  },
}
