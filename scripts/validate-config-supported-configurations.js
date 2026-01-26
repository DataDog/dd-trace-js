'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')
const SUPPORTED_JSON_PATH = path.join(REPO_ROOT, 'packages/dd-trace/src/config/supported-configurations.json')

function readJSON (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function fail (message) {
  /** @type {Error & { code?: string }} */
  const err = new Error(message)
  err.code = 'INVALID_SUPPORTED_CONFIGURATIONS'
  throw err
}

function isPlainObject (v) {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

function main () {
  const doc = readJSON(SUPPORTED_JSON_PATH)

  if (!isPlainObject(doc)) fail('Top-level document must be an object')
  if (typeof doc.version !== 'string' || doc.version.length === 0) fail('Top-level "version" must be a non-empty string')
  if (!isPlainObject(doc.supportedConfigurations)) fail('Top-level "supportedConfigurations" must be an object')

  if (Object.hasOwn(doc, 'aliases') || Object.hasOwn(doc, 'deprecations')) {
    fail('Top-level "aliases"/"deprecations" must not exist (moved into entry objects)')
  }

  for (const key of Object.keys(doc)) {
    if (key !== '__comment' && key !== 'version' && key !== 'supportedConfigurations') {
      fail(`Unexpected top-level key "${key}" (allowed: __comment, version, supportedConfigurations)`)
    }
  }

  if (Object.hasOwn(doc, '__comment') && (typeof doc.__comment !== 'string' || doc.__comment.length === 0)) {
    fail('Top-level "__comment" must be a non-empty string when present')
  }

  for (const [envVar, entries] of Object.entries(doc.supportedConfigurations)) {
    if (!Array.isArray(entries) || entries.length === 0) fail(`${envVar}: value must be a non-empty array`)
    for (const entry of entries) {
      if (!isPlainObject(entry)) fail(`${envVar}: entries must be objects`)
      if (typeof entry.implementation !== 'string' || entry.implementation.length === 0) {
        fail(`${envVar}: entry.implementation must be a non-empty string`)
      }
      if (typeof entry.type !== 'string' || entry.type.length === 0) fail(`${envVar}: entry.type must be a non-empty string`)
      if (typeof entry.description !== 'string' || entry.description.length === 0) {
        fail(`${envVar}: entry.description must be a non-empty string`)
      }
      if (Object.hasOwn(entry, 'programmaticConfig')) {
        if (typeof entry.programmaticConfig !== 'string' || entry.programmaticConfig.length === 0) {
          fail(`${envVar}: entry.programmaticConfig must be a non-empty string when present`)
        }
      }

      if (Object.hasOwn(entry, 'default')) {
        // Ensure JSON-serializable (best-effort)
        JSON.stringify(entry.default)
      } else {
        fail(`${envVar}: entry.default is mandatory`)
      }

      if (Object.hasOwn(entry, 'aliases')) {
        if (!Array.isArray(entry.aliases) || entry.aliases.some(a => typeof a !== 'string')) {
          fail(`${envVar}: entry.aliases must be an array of strings`)
        }
      }

      if (Object.hasOwn(entry, 'deprecations')) {
        if (!isPlainObject(entry.deprecations)) fail(`${envVar}: entry.deprecations must be an object`)
        const keys = Object.keys(entry.deprecations)
        if (keys.length !== 1 || keys[0] !== 'replacedBy') {
          fail(`${envVar}: entry.deprecations must be exactly { replacedBy: string }`)
        }
        if (typeof entry.deprecations.replacedBy !== 'string' || entry.deprecations.replacedBy.length === 0) {
          fail(`${envVar}: entry.deprecations.replacedBy must be a non-empty string`)
        }
      }
    }
  }
}

if (require.main === module) {
  main()
}
