'use strict'

const exec = require('./helpers/exec')

const pkg = require('../package.json')

const betaExpr = /\d+\.\d+\.\d+-.*/
const legacyExpr = /0\.\d+\.\d+/

if (!betaExpr.test(pkg.version) && !legacyExpr.test(pkg.version)) {
  exec(`node scripts/publish_docs.js "v${pkg.version}"`)
}
