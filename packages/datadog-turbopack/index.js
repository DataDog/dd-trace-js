'use strict'

const { createManifest } = require('./src/targets')

const loader = require.resolve('./src/loader')

/**
 * Adds Datadog instrumentation rules to a Turbopack configuration. Generated
 * aliases and loader metadata are local to the application and apply only to
 * Node.js bundles. Browser and Edge bundles retain their original modules.
 *
 * @param {object} [turbopack]
 * @param {string} [projectDir]
 * @returns {Promise<object>}
 */
function withDatadogTurbopack (turbopack, projectDir) {
  return addRules(turbopack, projectDir)
}

/**
 * @param {object} turbopack
 * @param {string} [projectDir]
 * @returns {Promise<object>}
 */
async function addRules (turbopack = {}, projectDir = process.cwd()) {
  const manifest = await createManifest(projectDir)
  if (!manifest.packagePathPattern || !manifest.path) return turbopack

  const aliases = { ...turbopack.resolveAlias }

  for (const [specifier, alias] of Object.entries(manifest.aliases)) {
    // Do not replace application aliases, which would change customer behavior.
    aliases[specifier] ??= alias
  }

  const rules = { ...turbopack.rules }
  for (const extension of ['*.js', '*.cjs', '*.mjs']) {
    const existing = rules[extension]
    const rule = {
      condition: {
        all: ['foreign', 'node', { path: manifest.packagePathPattern }],
      },
      loaders: [{ loader, options: { manifestPath: manifest.path } }],
    }
    rules[extension] = existing
      ? [...(Array.isArray(existing) ? existing : [existing]), rule]
      : rule
  }

  return {
    ...turbopack,
    resolveAlias: aliases,
    rules,
  }
}

module.exports = {
  withDatadogTurbopack,
}
