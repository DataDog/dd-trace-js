'use strict'

const { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const v5 = require('./config-overrides-v5.json')
const v7 = require('./config-overrides-v7.json')

/** @typedef {import('../../packages/dd-trace/src/config/helper').SupportedConfigurationEntry} ConfigurationEntry */
/**
 * @typedef {object} ConfigurationOverrides
 * @property {Record<string, string[]>} [configurationNames]
 * @property {Record<string, string[]>} [aliases]
 * @property {Record<string, ConfigurationEntry['default']>} defaults
 * @property {Record<string, ConfigurationEntry[]>} [entries]
 */

/**
 * @param {number} major
 * @returns {ConfigurationOverrides|undefined}
 */
function getConfigOverrides (major) {
  return major >= 7 ? v7 : major === 5 ? v5 : undefined
}

/**
 * @param {Record<string, ConfigurationEntry[]>} supportedConfigurations
 * @param {number} major
 */
function applyConfigOverrides (supportedConfigurations, major) {
  const overrides = getConfigOverrides(major)
  if (overrides === undefined) {
    return
  }

  for (const field of /** @type {const} */ (['configurationNames', 'aliases'])) {
    const mappings = overrides[field]
    if (mappings === undefined) {
      continue
    }
    for (const [name, additions] of Object.entries(mappings)) {
      const [entry] = supportedConfigurations[name]
      entry[field] = [...new Set([...(entry[field] ?? []), ...additions])]
    }
  }
  for (const [name, value] of Object.entries(overrides.defaults)) {
    supportedConfigurations[name][0].default = value
  }
  Object.assign(supportedConfigurations, overrides.entries)
}

// npm runs prepare alone when it packs a Git dependency.
if (require.main === module && (process.argv[2] !== '--prepare' || process.env.npm_package_resolved)) {
  const { DD_MAJOR } = require('../../version')
  if (getConfigOverrides(DD_MAJOR) !== undefined) {
    const filename = path.join(__dirname, '../../packages/dd-trace/src/config/supported-configurations.json')
    const source = readFileSync(filename, 'utf8')
    const schema = JSON.parse(source)
    applyConfigOverrides(schema.supportedConfigurations, DD_MAJOR)
    const output = JSON.stringify(schema, null, 2) + '\n'

    if (output !== source) {
      // The package file list excludes release scripts and their temporary files.
      const temporaryDirectory = mkdtempSync(path.join(__dirname, '.config-schema-'))
      try {
        const temporaryFile = path.join(temporaryDirectory, 'supported-configurations.json')
        writeFileSync(temporaryFile, output)
        renameSync(temporaryFile, filename)
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true })
      }
    }
  }
}

module.exports = applyConfigOverrides
