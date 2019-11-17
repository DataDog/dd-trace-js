'use strict'

const exec = require('./helpers/exec')

const pkg = require('../package.json')

const betaExpr = /\d+\.\d+\.\d+-beta\.\d+/

if (!betaExpr.test(pkg.version)) {
  exec(`node scripts/publish_docs.js "v${pkg.version}"`)
}
