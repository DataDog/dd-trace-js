'use strict'

const { execFileSync } = require('node:child_process')
const path = require('node:path')

const semver = require('semver')

const { sandboxCwd } = require('../helpers')

// 6.0.0 is the oldest supported version, 7 the last one bundling with Rollup and latest bundles with Rolldown.
const viteVersions = process.env.VITE_VERSION ? [process.env.VITE_VERSION] : ['6.0.0', '7', 'latest']

/**
 * @param {string} name
 */
function readPackageJson (name) {
  return require(path.join(sandboxCwd(), 'node_modules', name, 'package.json'))
}

/**
 * Release lines still testing older Node.js versions run these suites, but newer Vite versions and Vite-based tools
 * do not support them.
 *
 * @param {string[]} names
 */
function supportsNode (names) {
  return names.every(name => {
    const { engines } = readPackageJson(name)
    return !engines?.node || semver.satisfies(process.versions.node, engines.node)
  })
}

/**
 * Runs an executable installed in the sandbox, unless given as an absolute path.
 *
 * @param {string} cwd
 * @param {string} command
 * @param {string[]} args
 * @param {Record<string, string | undefined>} [env]
 * @param {number} [timeout] Synchronous commands block mocha's own timeouts, so they need their own.
 */
function run (cwd, command, args, env, timeout = 180_000) {
  const { NODE_OPTIONS, ...processEnv } = process.env
  const file = path.isAbsolute(command) ? command : path.join(sandboxCwd(), 'node_modules', '.bin', command)
  execFileSync(file, args, {
    cwd,
    env: { ...processEnv, ...env },
    killSignal: 'SIGKILL',
    stdio: 'inherit',
    timeout,
  })
}

module.exports = { readPackageJson, run, supportsNode, viteVersions }
