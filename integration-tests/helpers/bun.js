'use strict'

const { readFileSync } = require('fs')
const { join, resolve } = require('path')

const { dependencies } = require('../../packages/dd-trace/test/plugins/versions/package.json')

const PROJECT_ROOT = resolve(__dirname, '..', '..')
const BUN_INSTALL = join(PROJECT_ROOT, 'node_modules', '.cache', 'bun')
const BUN = join(PROJECT_ROOT, 'node_modules', '.bin', 'bun')
const BUN_CONFIG = join(PROJECT_ROOT, 'bunfig.toml')
const YARN_MODERN = `"${BUN}" x --package=@yarnpkg/cli-dist@${dependencies['@yarnpkg/cli-dist']} yarn`
const YARN = `"${BUN}" x yarn@${dependencies.yarn}`

// Yarn Berry skips versions published less than a day ago (npmMinimalAgeGate). Sandboxes install with Bun first, so
// Yarn exempts the same packages that bunfig.toml exempts from its release age gate.
const YARN_NPM_PREAPPROVED_PACKAGES = getReleaseAgeExcludes().join(',')

/**
 * The CI install action loads this module before dependencies are installed, so an unrecognized bunfig.toml
 * format yields no exclusions instead of throwing.
 *
 * @returns {string[]}
 */
function getReleaseAgeExcludes () {
  const bunfig = readFileSync(BUN_CONFIG, 'utf8')
    .split('\n')
    .map(line => line.split('#', 1)[0])
    .join('\n')
  const excludes = bunfig.match(/^minimumReleaseAgeExcludes\s*=\s*\[([^\]]*)\]/m)?.[1] ?? ''
  return [...excludes.matchAll(/"([^"]+)"/g)].map(([, name]) => name)
}

/**
 * @param {typeof process.env} [env]
 * @returns {typeof process.env & { BUN_INSTALL: string, YARN_NPM_PREAPPROVED_PACKAGES: string }}
 */
function withBun (env = process.env) {
  return { ...env, BUN_INSTALL, YARN_NPM_PREAPPROVED_PACKAGES }
}

module.exports = { BUN, BUN_CONFIG, YARN, YARN_MODERN, withBun }
