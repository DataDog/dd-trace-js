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
  for (const extension of ['*.js', '*.cjs', '*.mjs']) {
    const configured = rules[extension] ? [rules[extension]].flat() : []
    if (configured.some(rule => isCurrentDatadogLoader(rule, manifest.hash))) continue
    const existing = configured.filter(rule => !isDatadogLoader(rule))

    const targetCondition = ['foreign', 'node', { path: manifest.packagePathPattern }]
    if (manifest.esmImportPattern) targetCondition.push({ not: { content: manifest.esmImportPattern } })

    const datadogRules = [{
      condition: {
        all: targetCondition,
      },
      loaders: [{ loader, options: { manifestHash: manifest.hash, manifestPath: manifest.path } }],
    }]
    if (manifest.esmImportPattern) {
      datadogRules.push({
        condition: {
          all: ['node', { content: manifest.esmImportPattern }],
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
      const relativeCondition = ['node', { not: 'foreign' }, { path: manifest.relativePathPattern }]
      if (manifest.esmImportPattern) relativeCondition.push({ not: { content: manifest.esmImportPattern } })
      datadogRules.push({
        condition: { all: relativeCondition },
        loaders: [{ loader, options: { manifestHash: manifest.hash, manifestPath: manifest.path } }],
      })
    }
    rules[extension] = existing.length > 0
      ? [...existing, ...datadogRules]
      : datadogRules.length === 1 ? datadogRules[0] : datadogRules
  }

  return {
    ...turbopack,
    rules,
  }
}

function isDatadogLoader (rule) {
  return rule?.loaders?.some(item => item?.loader === loader)
}

function isCurrentDatadogLoader (rule, manifestHash) {
  return rule?.loaders?.some(item => item?.loader === loader && item.options?.manifestHash === manifestHash)
}

module.exports = {
  withDatadogTurbopack,
}
