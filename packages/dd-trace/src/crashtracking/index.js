'use strict'

const { existsSync } = require('node:fs')
const { isMainThread } = require('worker_threads')
const log = require('../log')

// libdatadog v29 crashtracker segfaults during init on ARM64 musl (Alpine).
// The segfault bypasses JS try/catch so we must avoid loading it entirely.
// See: https://github.com/DataDog/libdatadog-nodejs/issues/114
const isArm64Musl = process.arch === 'arm64' && existsSync('/etc/alpine-release')

if (isMainThread && !isArm64Musl) {
  try {
    module.exports = require('./crashtracker')
  } catch (e) {
    log.warn(e.message)
    module.exports = require('./noop')
  }
} else {
  module.exports = require('./noop')
}
