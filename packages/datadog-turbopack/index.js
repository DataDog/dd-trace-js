'use strict'

const { createManifest } = require('./src/targets')

const loader = require.resolve('./src/loader')

/**
 * Adds Datadog instrumentation rules to a Turbopack configuration. Generated
 * loader metadata is local to the application and applies only to Node.js
 * bundles. Browser and Edge bundles retain their original modules.
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

  const rules = { ...turbopack.rules }
  const aliases = Object.keys(turbopack.resolveAlias ?? {})
  for (const extension of ['*.js', '*.cjs', '*.mjs', '*.jsx', '*.ts', '*.tsx']) {
    const existing = rules[extension]
    if (hasDatadogLoader(existing)) continue

    const datadogRules = [{
      condition: {
        all: ['foreign', 'node', { path: manifest.packagePathPattern }],
      },
      loaders: [{ loader, options: { manifestHash: manifest.hash, manifestPath: manifest.path } }],
    }]
    if (manifest.esmImportPattern) {
      datadogRules.push({
        condition: {
          all: ['node', { not: 'foreign' }, { content: manifest.esmImportPattern }],
        },
        loaders: [{
          loader,
          options: {
            aliases,
            manifestHash: manifest.hash,
            manifestPath: manifest.path,
            rewriteApplicationImports: true,
          },
        }],
      })
    }
    if (manifest.relativePathPattern) {
      datadogRules.push({
        condition: {
          all: ['node', { not: 'foreign' }, { path: manifest.relativePathPattern }],
        },
        loaders: [{ loader, options: { manifestHash: manifest.hash, manifestPath: manifest.path } }],
      })
    }
    rules[extension] = existing
      ? [...(Array.isArray(existing) ? existing : [existing]), ...datadogRules]
      : datadogRules.length === 1 ? datadogRules[0] : datadogRules
  }

  return {
    ...turbopack,
    rules,
  }
}

function hasDatadogLoader (rules) {
  return [rules].flat().some(rule => rule?.loaders?.some(item => item?.loader === loader))
}

module.exports = {
  withDatadogTurbopack,
}
