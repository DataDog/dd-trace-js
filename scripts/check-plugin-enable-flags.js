#!/usr/bin/env node

'use strict'

/* eslint-disable no-console */

// Every plugin in the runtime registry is switched off through `DD_TRACE_<PLUGIN_ID>_ENABLED`. PluginManager only
// reads that variable when it is listed in `supported-configurations.json`; for an unlisted one it silently ignores
// the user's opt-out and the plugin stays on. Plugin pull requests have repeatedly forgotten the entry, so this check
// fails when a registered plugin has no matching entry.

const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const PLUGINS_INDEX = join('packages', 'dd-trace', 'src', 'plugins', 'index.js')
const SUPPORTED_CONFIGURATIONS = join('packages', 'dd-trace', 'src', 'config', 'supported-configurations.json')

// Plugin ids that have no user-facing enable flag on purpose.
const NO_ENABLE_FLAG = new Set([
  // Internal plugin behind the dd-trace-api shim. It is not part of the public plugin list.
  'dd-trace-api',
])

// Plugins that predate this check and still lack their flag. Do not add to this list: register the flag in
// `supported-configurations.json` instead, and remove the entry here once it exists.
const KNOWN_MISSING = new Set([
  'elevenlabs',
])

// Mirrors normalizePluginEnvName() in packages/dd-trace/src/util.js.
function toEnvName (pluginId) {
  return `DD_TRACE_${pluginId.toUpperCase()}_ENABLED`.replaceAll(/[^a-z0-9_]/gi, '_')
}

/**
 * Reads the plugin id from the source, without loading the plugin and its dependencies.
 *
 * @param {string} source
 * @returns {string | undefined}
 */
function readPluginId (source) {
  const patterns = [
    /static\s+id\s*=\s*(['"])([^'"]+)\1/,
    /static\s+get\s+id\s*\(\s*\)\s*\{\s*return\s+(['"])([^'"]+)\1/,
    /\.id\s*=\s*(['"])([^'"]+)\1/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(source)
    if (match) return match[2]
  }
}

/**
 * @param {string} root Repository root.
 * @returns {string[]} Violation messages.
 */
function check (root) {
  const registry = readFileSync(join(root, PLUGINS_INDEX), 'utf8')
  const { supportedConfigurations } = JSON.parse(readFileSync(join(root, SUPPORTED_CONFIGURATIONS), 'utf8'))

  const known = new Set(Object.keys(supportedConfigurations))
  for (const entries of Object.values(supportedConfigurations)) {
    for (const entry of entries) {
      for (const alias of entry.aliases ?? []) known.add(alias)
    }
  }

  const packages = new Set(registry.match(/datadog-plugin-[\w-]+/g))
  const violations = []

  for (const packageName of [...packages].sort()) {
    const entryPoint = join(root, 'packages', packageName, 'src', 'index.js')
    if (!existsSync(entryPoint)) {
      violations.push(`${packageName}: listed in ${PLUGINS_INDEX} but packages/${packageName}/src/index.js is missing.`)
      continue
    }

    const id = readPluginId(readFileSync(entryPoint, 'utf8'))
    if (id === undefined) {
      violations.push(
        `${packageName}: could not read the plugin id from packages/${packageName}/src/index.js. ` +
        'Declare it as `static id = \'...\'`.'
      )
      continue
    }

    if (NO_ENABLE_FLAG.has(id) || KNOWN_MISSING.has(id)) continue

    const envName = toEnvName(id)
    if (!known.has(envName)) {
      violations.push(
        `${packageName}: ${envName} is missing from ${SUPPORTED_CONFIGURATIONS}. ` +
        `Without it, ${envName}=false is ignored and the plugin stays enabled. ` +
        'Add it as a boolean with default "true".'
      )
    }
  }

  return violations
}

if (require.main === module) {
  const violations = check(process.cwd())
  if (violations.length > 0) {
    for (const violation of violations) console.error(violation)
    process.exitCode = 1
  }
}

module.exports = { check, readPluginId, toEnvName }
