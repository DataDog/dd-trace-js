'use strict'

const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const instrumentations = require('../packages/datadog-instrumentations/src/helpers/rewriter/instrumentations')

const CHECK_FLAG = '--check'
const OUTPUT_PATH_IN_REPOSITORY = 'packages/datadog-instrumentations/src/helpers/rewriter/targets.json'
const OUTPUT_PATH = path.join(__dirname, '..', OUTPUT_PATH_IN_REPOSITORY)

function generateRewriterTargets () {
  /** @type {Record<string, string>} */
  const targets = {}

  for (const { module: { name, filePath } } of instrumentations) {
    targets[`${name}/${filePath}`] = name
  }

  // The replacer array orders the keys, so adding a descriptor stays a one-line diff.
  return `${JSON.stringify(targets, Object.keys(targets).sort(), 2)}\n`
}

function checkRewriterTargets () {
  if (readFileSync(OUTPUT_PATH, 'utf8').replaceAll('\r\n', '\n') === generateRewriterTargets()) {
    return true
  }

  // eslint-disable-next-line no-console
  console.error(`❌ The rewriter target map is out of date.

The checked-in map no longer matches the rewriter instrumentation descriptors in:
- packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/

A stale map silently disables rewriting for the descriptors it is missing.

To regenerate it locally, run:
  npm run generate:rewriter:targets

Then commit the updated file:
  ${OUTPUT_PATH_IN_REPOSITORY}
`)
  return false
}

if (require.main === module) {
  if (process.argv.includes(CHECK_FLAG)) {
    process.exitCode = checkRewriterTargets() ? 0 : 1
  } else {
    writeFileSync(OUTPUT_PATH, generateRewriterTargets())
  }
}

module.exports = {
  generateRewriterTargets,
  OUTPUT_PATH,
}
