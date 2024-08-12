'use strict'

/* eslint-disable no-console */

const npmArgv = (() => {
  try {
    return JSON.parse(process.env.npm_config_argv)
  } catch (e) {
    return { original: [] }
  }
})()

let path // , Module
try {
  path = require('node:path')
  // Module = require('node:module')
} catch (e) {
  // If using a Node version pre-14, the `node:` protocol is not available
  // with require() so we fall back to not using it, and patch require to
  // accept it so that other imports with the prefix will work
  path = require('path')
  // Module = require('module')

  // const origRequire = Module.prototype.require
  // const wrappedRequire = (request) => {
  //   if (request.startsWith('node:')) {
  //     request = request.replace(/^node:/, '')
  //   }
  //   return origRequire.call(this, request)
  // }
  // Module.prototype.require = wrappedRequire
}

const requirePackageJson = require('../packages/dd-trace/src/require-package-json.js')

const nodeMajor = Number(process.versions.node.split('.')[0])

const min = Number(requirePackageJson(path.join(__dirname, '..')).engines.node.match(/\d+/)[0])

const hasIgnoreEngines = npmArgv &&
  npmArgv.original &&
  npmArgv.original.includes('--ignore-engines')

if (nodeMajor < min && !hasIgnoreEngines) {
  process.exitCode = 1
  console.error('\n' + `
You're using Node.js v${process.versions.node}, which is not supported by
dd-trace.

Please upgrade to a more recent version of Node.js.
  `.trim() + '\n')
}
