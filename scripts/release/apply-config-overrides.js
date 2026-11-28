'use strict'

const { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const v5 = require('./config-overrides-v5.json')
const v6 = require('./config-overrides-v6.json')

/** @typedef {import('../../packages/dd-trace/src/config/helper').SupportedConfigurationEntry} ConfigurationEntry */
/**
 * @typedef {object} ConfigurationOverrides
 * @property {Record<string, string[]>} [configurationNames]
 * @property {Record<string, string[]>} [aliases]
 * @property {Record<string, { base: ConfigurationEntry['default'], legacy: ConfigurationEntry['default'] }>} defaults
 * @property {Record<string, ConfigurationEntry[]>} [entries]
 */

const supportedMajors = new Set([5, 6, 7])

/**
 * @param {Record<string, ConfigurationEntry[]>} supportedConfigurations
 * @param {number} major
 */
function applyConfigOverrides (supportedConfigurations, major) {
  if (!supportedMajors.has(major)) {
    return
  }

  applyOverlay(supportedConfigurations, v6, major <= 6)
  applyOverlay(supportedConfigurations, v5, major === 5)
}

/**
 * @param {Record<string, ConfigurationEntry[]>} supportedConfigurations
 * @param {ConfigurationOverrides} overrides
 * @param {boolean} enabled
 */
function applyOverlay (supportedConfigurations, overrides, enabled) {
  for (const field of /** @type {const} */ (['configurationNames', 'aliases'])) {
    const mappings = overrides[field]
    if (mappings === undefined) {
      continue
    }
    for (const [name, additions] of Object.entries(mappings)) {
      const [entry] = supportedConfigurations[name]
      const existing = entry[field]
      if (enabled) {
        entry[field] = [...new Set([...(existing ?? []), ...additions])]
      } else if (existing !== undefined) {
        const remaining = existing.filter(value => !additions.includes(value))
        if (remaining.length === 0) {
          delete entry[field]
        } else {
          entry[field] = remaining
        }
      }
    }
  }
  for (const [name, { base, legacy }] of Object.entries(overrides.defaults)) {
    supportedConfigurations[name][0].default = enabled ? legacy : base
  }
  if (overrides.entries !== undefined) {
    if (enabled) {
      Object.assign(supportedConfigurations, overrides.entries)
    } else {
      for (const name of Object.keys(overrides.entries)) {
        delete supportedConfigurations[name]
      }
    }
  }
}

if (require.main === module) {
  const { DD_MAJOR } = require('../../version')
  if (supportedMajors.has(DD_MAJOR)) {
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
