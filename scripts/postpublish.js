'use strict'

const exec = require('./helpers/exec')

const pkg = require('../package.json')

const betaExpr = /\d+\.\d+\.\d+-.*/
const legacyExpr = /0\.\d+\.\d+/

if (!betaExpr.test(pkg.version)) {
  if (legacyExpr.test(pkg.version)) {
    exec(`yarn tag add dd-trace@${pkg.version} latest-node8`)
    exec(`yarn tag add dd-trace@${pkg.version} latest-node10`)
  }

  exec(`node scripts/publish_docs.js "v${pkg.version}"`)
}
