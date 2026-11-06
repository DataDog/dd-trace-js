'use strict'

const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const {
  instrumentations,
} = require('../packages/datadog-instrumentations/src/helpers/rewriter/instrumentation-registry')

const CHECK_FLAG = '--check'
const OUTPUT_PATH_IN_REPOSITORY = 'packages/datadog-instrumentations/src/helpers/rewriter/targets.json'
const OUTPUT_PATH = path.join(__dirname, '..', OUTPUT_PATH_IN_REPOSITORY)
const PATTERN_OUTPUT_PATH_IN_REPOSITORY = 'packages/datadog-instrumentations/src/helpers/rewriter/target-patterns.json'
const PATTERN_OUTPUT_PATH = path.join(__dirname, '..', PATTERN_OUTPUT_PATH_IN_REPOSITORY)

function generateRewriterTargets () {
  /** @type {Record<string, string>} */
  const targets = {}

  for (const { module: { name, filePath } } of instrumentations) {
    if (typeof filePath === 'string') targets[`${name}/${filePath}`] = name
  }

  return `${JSON.stringify(targets, Object.keys(targets).sort(), 2)}\n`
}

function generateRewriterTargetPatterns () {
  const patterns = new Map()
  /** @type {Map<string, Set<string>|undefined>} */
  const sourceMatches = new Map()
  for (const { module: { name, filePath, sourceMatch } } of instrumentations) {
    if (!(filePath instanceof RegExp)) continue
    const key = `${name}|${filePath}`
    // Descriptors of one package can target different chunks behind the same file pattern. A chunk is a target
    // when it contains any of their markers, and a descriptor without a marker accepts every matching chunk.
    if (!patterns.has(key)) sourceMatches.set(key, new Set())
    if (sourceMatch === undefined) {
      sourceMatches.set(key, undefined)
    } else {
      sourceMatches.get(key)?.add(sourceMatch)
    }
    patterns.set(key, { name, source: filePath.source, flags: filePath.flags })
  }
  for (const [key, pattern] of patterns) {
    const markers = sourceMatches.get(key)
    if (markers) pattern.sourceMatch = markers.size === 1 ? [...markers][0] : [...markers]
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
