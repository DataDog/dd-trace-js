'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')
const SUPPORTED_JSON_PATH = path.join(REPO_ROOT, 'packages/dd-trace/src/config/supported-configurations.json')
const OUT_PATH = path.join(
  REPO_ROOT,
  'packages/dd-trace/src/config/supported-configurations.missing-descriptions.json'
)

function readJSON (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJSON (file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

function main () {
  const doc = readJSON(SUPPORTED_JSON_PATH)
  const supported = doc?.supportedConfigurations || {}
  const missing = []
  for (const [envVar, entries] of Object.entries(supported)) {
    const entry = Array.isArray(entries) ? entries[0] : undefined
    if (!entry || typeof entry !== 'object') continue
    if (entry.description === '__UNKNOWN__') missing.push(envVar)
  }
  missing.sort()
  writeJSON(OUT_PATH, missing)
  process.stdout.write(`missingDescriptions: ${missing.length}\nWrote ${OUT_PATH}\n`)
}

if (require.main === module) {
  main()
}
