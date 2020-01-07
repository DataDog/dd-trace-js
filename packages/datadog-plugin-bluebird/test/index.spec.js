'use strict'

const assertPromise = require('../../dd-trace/test/plugins/promise')
const semver = require('semver')

assertPromise('bluebird')

assertPromise('bluebird', bluebird => {
  return bluebird.getNewLibraryCopy()
}, version => { semver.intersects(version, '^2.11.0 || ^3.4.1') })
