'use strict'

const fs = require('node:fs')
const path = require('node:path')

const OTEL_API_PACKAGES = ['@opentelemetry/api', '@opentelemetry/api-logs']

/**
 * Decide which OpenTelemetry API packages a bundle must keep external.
 *
 * The bridge captures the application's own copy through require interception, which only fires on a
 * runtime require. Bundling a copy the application also owns would inline a second copy the
 * interception never sees, so the bridge would register its provider on the wrong copy and silently
 * downgrade every span to a no-op (issue #6882). A package the application does not declare has no
 * competing copy, so it is left to bundle: dd-trace's own fallback copy is inlined and the bundle
 * stays self-contained, needing no `@opentelemetry/api` in `node_modules` at runtime.
 *
 * @param {string} workingDir Directory whose `package.json` lists the application's dependencies.
 * @returns {string[]} The subset of `OTEL_API_PACKAGES` to mark external.
 */
function otelApiPackagesToExternalize (workingDir) {
  const declared = readDeclaredDependencies(workingDir)
  // A missing or unreadable manifest is inconclusive, so err toward external: sharing the
  // application's copy is the correctness-preserving default and only costs the self-contained-bundle
  // optimization when the application in fact owns no copy.
  if (!declared) return OTEL_API_PACKAGES
  return OTEL_API_PACKAGES.filter(name => declared.has(name))
}

/**
 * @param {string} workingDir
 * @returns {Set<string> | undefined} All declared dependency names, or `undefined` when the manifest
 *   cannot be read.
 */
function readDeclaredDependencies (workingDir) {
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(workingDir, 'package.json'), 'utf8'))
  } catch {
    return
  }
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])
}

module.exports = { OTEL_API_PACKAGES, otelApiPackagesToExternalize }
