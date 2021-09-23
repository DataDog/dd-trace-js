'use strict'

const exec = require('./helpers/exec')

const pkg = require('../package.json')

const betaExpr = /\d+\.\d+\.\d+-.*/
const legacyExpr = /0\.\d+\.\d+/

if (!betaExpr.test(pkg.version) && !legacyExpr.test(pkg.version)) {
  const releaseBranches = exec.pipe('git fetch && git branch -a | grep -E "/v\\d+\\.x"')
    .trim()
    .split(/\s+/)
  const releaseMajors = releaseBranches
    .map(branch => parseInt(branch.replace(/[^0-9]/g, '')))
    .sort()
    .reverse()
  const latestMajor = releaseMajors[0]
  const currentMajor = parseInt(pkg.version.split('.')[0])

  if (currentMajor === latestMajor) {
    exec(`node scripts/publish_docs.js "v${pkg.version}"`)
  }
}
