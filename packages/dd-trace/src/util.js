'use strict'

const path = require('path')
const gypBuild = require('node-gyp-build')

function isTrue (str) {
  str = String(str).toLowerCase()
  return str === 'true' || str === '1'
}

function isFalse (str) {
  str = String(str).toLowerCase()
  return str === 'false' || str === '0'
}

function isError (value) {
  if (value instanceof Error) {
    return true
  }
  if (value && value.constructor) {
    return value.constructor.name === 'JestAssertionError' ||
      value.constructor.name === 'Error' ||
      value.constructor.name === 'ErrorWithStack'
  }
  return false
}

// Taken from node-gyp-build
const runtimeRequire = typeof __webpack_require__ === 'function' ? __non_webpack_require__ : require // eslint-disable-line
function loadAddon (name) {
  let addonPath = gypBuild.path(path.join(__dirname, '..', '..', '..'))
  const file = path.basename(addonPath)
  if (file !== name) {
    addonPath = path.join(path.dirname(addonPath), name)
  }
  return runtimeRequire(addonPath)
}

function loadMetrics () {
  return loadAddon('metrics.node')
}

module.exports = {
  isTrue,
  isFalse,
  isError,
  loadMetrics
}
