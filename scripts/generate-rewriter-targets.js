'use strict'

const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const { registry } = require('../packages/datadog-instrumentations/src/helpers/rewriter/instrumentation-registry')

const CHECK_FLAG = '--check'
const OUTPUT_PATH_IN_REPOSITORY = 'packages/datadog-instrumentations/src/helpers/rewriter/targets.json'
const OUTPUT_PATH = path.join(__dirname, '..', OUTPUT_PATH_IN_REPOSITORY)
const PATTERNS_PATH_IN_REPOSITORY = 'packages/datadog-instrumentations/src/helpers/rewriter/target-patterns.json'
const PATTERNS_OUTPUT_PATH = path.join(__dirname, '..', PATTERNS_PATH_IN_REPOSITORY)

function collectRewriterTargets () {
  /** @type {Record<string, string>} */
  const targets = {}
  /** @type {Record<string, string[]>} */
  const patterns = {}
  const activatedModules = new Set()

  for (const { activationName, instrumentations } of registry) {
    let activatedModuleName
    for (const { module: { name, filePath } } of instrumentations) {
      const targetPath = /** @type {string | RegExp} */ (filePath)
      if (targetPath instanceof RegExp) {
        if (targetPath.flags || !targetPath.source.startsWith('^') || !targetPath.source.endsWith('$')) {
          throw new Error(`Rewrite target ${name} has an unanchored or stateful file pattern`)
        }
        const packagePatterns = patterns[name] ??= []
        if (!packagePatterns.includes(targetPath.source)) packagePatterns.push(targetPath.source)
      } else {
        targets[`${name}/${targetPath}`] = name
      }

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

  return { targets, patterns }
}

function generateRewriterTargets () {
  const { targets } = collectRewriterTargets()
  return `${JSON.stringify(targets, Object.keys(targets).sort(), 2)}\n`
}

function generateRewriterPatterns () {
  const { patterns } = collectRewriterTargets()
  for (const sources of Object.values(patterns)) sources.sort()
  return `${JSON.stringify(patterns, Object.keys(patterns).sort(), 2)}\n`
}

function checkRewriterTargets () {
  if (readFileSync(OUTPUT_PATH, 'utf8').replaceAll('\r\n', '\n') === generateRewriterTargets() &&
    readFileSync(PATTERNS_OUTPUT_PATH, 'utf8').replaceAll('\r\n', '\n') === generateRewriterPatterns()) {
    return true
  }

  // eslint-disable-next-line no-console
  console.error(`❌ The generated rewriter metadata is out of date.

The checked-in maps no longer match the registered rewriter instrumentation descriptors in:
- packages/datadog-instrumentations/src/helpers/rewriter/instrumentation-registry.js

A stale file can silently disable rewriting or plugin activation.

To regenerate it locally, run:
  npm run generate:rewriter:targets

Then commit the updated files:
  ${OUTPUT_PATH_IN_REPOSITORY}
  ${PATTERNS_PATH_IN_REPOSITORY}
`)
  return false
}

if (require.main === module) {
  if (process.argv.includes(CHECK_FLAG)) {
    process.exitCode = checkRewriterTargets() ? 0 : 1
  } else {
    writeFileSync(OUTPUT_PATH, generateRewriterTargets())
    writeFileSync(PATTERNS_OUTPUT_PATH, generateRewriterPatterns())
  }
}

module.exports = {
  generateRewriterTargets,
  generateRewriterPatterns,
  OUTPUT_PATH,
  PATTERNS_OUTPUT_PATH,
}
