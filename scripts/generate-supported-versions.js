#!/usr/bin/env node
'use strict'

const { writeFileSync } = require('node:fs')
const path = require('node:path')

const { generateSupportedIntegrations } = require('./generate-supported-integrations')

const OUTPUT_PATH = path.join(__dirname, '..', 'supported_versions.json')

/**
 * Convert the supported integrations table into the per-dependency format that
 * CI publishes for the integration support matrix: each entry lists the
 * supported range, the newest version the tracer is tested against, and the
 * Node.js versions at the ends of the supported engine range.
 *
 * @param {Array<Record<string, string>>} rows
 * @param {{ min: string, max: string }} nodeRange
 */
function toSupportedVersions (rows, nodeRange) {
  const node = [...new Set([nodeRange.min, nodeRange.max].filter(Boolean))]
  return rows.map(row => ({
    dependencyName: row.dependency,
    integrationName: row.integration,
    autoInstrumented: row['auto-instrumented'] === 'True',
    versions: [{
      testedRuntimes: { node },
      supportedRange: `>=${row.minimum_tracer_supported}`,
      tested: [row.max_tracer_supported],
    }],
  }))
}

async function main () {
  const { rows, nodeRange } = await generateSupportedIntegrations()
  writeFileSync(OUTPUT_PATH, JSON.stringify(toSupportedVersions(rows, nodeRange), null, 2) + '\n')
}

if (require.main === module) {
  main().catch(error => {
    // eslint-disable-next-line no-console
    console.error(error)
    process.exitCode = 1
  })
}

module.exports = { toSupportedVersions }
