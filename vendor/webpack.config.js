'use strict'

const { hash } = require('crypto')
const { join } = require('path')
const pkg = require('./package.json')
const { readFileSync } = require('fs')

const dependOn = Object.keys(pkg.dependencies)
const version = hash('sha256', readFileSync(__filename))

module.exports = {
  entry: Object.fromEntries(dependOn.map((next) => [next, `./node_modules/${next}`])),
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
