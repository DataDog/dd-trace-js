'use strict'

const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const { registry } = require('../packages/datadog-instrumentations/src/helpers/rewriter/instrumentation-registry')

const CHECK_FLAG = '--check'
const OUTPUT_PATH_IN_REPOSITORY = 'packages/datadog-instrumentations/src/helpers/rewriter/targets.json'
const OUTPUT_PATH = path.join(__dirname, '..', OUTPUT_PATH_IN_REPOSITORY)
const PATTERN_OUTPUT_PATH_IN_REPOSITORY = 'packages/datadog-instrumentations/src/helpers/rewriter/target-patterns.json'
const PATTERN_OUTPUT_PATH = path.join(__dirname, '..', PATTERN_OUTPUT_PATH_IN_REPOSITORY)

function generateRewriterTargets () {
  /** @type {Record<string, string>} */
  const targets = {}
  const activatedModules = new Set()

  for (const { activationName, instrumentations } of registry) {
    let activatedModuleName
    for (const { module: { name, filePath } } of instrumentations) {
      if (typeof filePath === 'string') targets[`${name}/${filePath}`] = name

      if (!activationName) continue
      if (activatedModuleName && activatedModuleName !== name) {
        throw new Error(`Rewrite activation group ${activationName} contains multiple modules`)
      }
      activatedModuleName = name
    }
    if (activationName && !activatedModuleName) {
      throw new Error(`Rewrite activation group ${activationName} has no instrumentations`)
    }
    if (activatedModuleName) {
      if (activatedModules.has(activatedModuleName)) {
        throw new Error(`Rewrite target ${activatedModuleName} has multiple activation groups`)
      }
      activatedModules.add(activatedModuleName)
    }
  }

  return `${JSON.stringify(targets, Object.keys(targets).sort(), 2)}\n`
}

function generateRewriterTargetPatterns () {
  const patterns = new Map()
  for (const { instrumentations } of registry) {
    for (const { module: { name, filePath, sourceMatch } } of instrumentations) {
      if (!(filePath instanceof RegExp)) continue
      patterns.set(`${name}|${filePath}`, { name, source: filePath.source, flags: filePath.flags, sourceMatch })
    }
  }
  return `${JSON.stringify([...patterns.values()], null, 2)}\n`
}

function checkRewriterTargets () {
  if (readFileSync(OUTPUT_PATH, 'utf8').replaceAll('\r\n', '\n') === generateRewriterTargets() &&
    readFileSync(PATTERN_OUTPUT_PATH, 'utf8').replaceAll('\r\n', '\n') === generateRewriterTargetPatterns()) {
    return true
  }

  // eslint-disable-next-line no-console
  console.error(`❌ The generated rewriter metadata is out of date.

The checked-in map no longer matches the registered rewriter instrumentation descriptors in:
- packages/datadog-instrumentations/src/helpers/rewriter/instrumentation-registry.js

A stale file can silently disable rewriting or plugin activation.

To regenerate it locally, run:
  npm run generate:rewriter:targets

Then commit the updated file:
  ${OUTPUT_PATH_IN_REPOSITORY}
  ${PATTERN_OUTPUT_PATH_IN_REPOSITORY}
`)
  return false
}

if (require.main === module) {
  if (process.argv.includes(CHECK_FLAG)) {
    process.exitCode = checkRewriterTargets() ? 0 : 1
  } else {
    writeFileSync(OUTPUT_PATH, generateRewriterTargets())
    writeFileSync(PATTERN_OUTPUT_PATH, generateRewriterTargetPatterns())
  }
}

module.exports = {
  generateRewriterTargets,
  generateRewriterTargetPatterns,
  OUTPUT_PATH,
  PATTERN_OUTPUT_PATH,
}
