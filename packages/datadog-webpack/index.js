'use strict'

const fs = require('node:fs')

const instrumentations = require('../datadog-instrumentations/src/helpers/instrumentations')
const { getGitMetadata } = require('../datadog-instrumentations/src/helpers/bundler-git-metadata')
const { isESMFile } = require('../datadog-instrumentations/src/helpers/bundler-utils')
const extractPackageAndModulePath = require('../datadog-instrumentations/src/helpers/extract-package-and-module-path')
const hooks = require('../datadog-instrumentations/src/helpers/hooks')
const { getRewriteTarget } = require('../datadog-instrumentations/src/helpers/rewriter/targets')
const { getValueFromEnvSources } = require('../dd-trace/src/config/helper')
const log = require('./src/log')

const PLUGIN_NAME = 'DatadogWebpackPlugin'

const DD_BUNDLER_INJECT_GIT_METADATA = getValueFromEnvSources('DD_BUNDLER_INJECT_GIT_METADATA') !== false

for (const hook of Object.values(hooks)) {
  if (hook !== null && typeof hook === 'object') {
    hook.fn()
  } else {
    hook()
  }
}

const modulesOfInterest = new Set()

for (const [name, instrumentation] of Object.entries(instrumentations)) {
  for (const entry of instrumentation) {
    if (entry.file) {
      modulesOfInterest.add(`${name}/${entry.file}`) // e.g. "redis/my/file.js"
    } else {
      modulesOfInterest.add(name) // e.g. "redis"
    }
  }
}

class DatadogWebpackPlugin {
  /**
   * @param {object} compiler
   */
  apply (compiler) {
    // optimization.minimize is not yet set when apply() is called in webpack 5.54.0+
    // (applyWebpackOptionsDefaults runs after plugins), so we defer the check to the
    // environment hook which fires synchronously after defaults are applied.
    compiler.hooks.environment.tap(PLUGIN_NAME, () => {
      if (compiler.options.optimization?.minimize) {
        throw new Error(
          'optimization.minimize is not compatible with DatadogWebpackPlugin and will break dd-trace ' +
          'instrumentation. Disable optimization.minimize when using this plugin.'
        )
      }
    })

    // Bake DD_GIT_* into assets unless DD_BUNDLER_INJECT_GIT_METADATA=false (stable artifact hashes).
    if (DD_BUNDLER_INJECT_GIT_METADATA) {
      const gitMetadata = getGitMetadata(log)
      if (gitMetadata.repositoryURL || gitMetadata.commitSHA) {
        const banner =
          'if (typeof process === \'object\' && process !== null &&\n' +
          '    process.env !== null && typeof process.env === \'object\') {\n' +
          (gitMetadata.repositoryURL
            ? `  process.env.DD_GIT_REPOSITORY_URL = ${JSON.stringify(gitMetadata.repositoryURL)};\n`
            : '') +
          (gitMetadata.commitSHA
            ? `  process.env.DD_GIT_COMMIT_SHA = ${JSON.stringify(gitMetadata.commitSHA)};\n`
            : '') +
          '}\n'

        compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
          compilation.hooks.processAssets.tap(
            { name: PLUGIN_NAME, stage: -2000 },
            () => {
              for (const chunk of compilation.chunks) {
                if (!chunk.canBeInitial()) continue
                for (const filename of chunk.files) {
                  if (!filename.endsWith('.js') && !filename.endsWith('.mjs')) continue
                  compilation.updateAsset(filename, (old) => {
                    const content = banner + old.source()
                    return {
                      source () { return content },
                      size () { return Buffer.byteLength(content, 'utf8') },
                      map () { return old.map() },
                      sourceAndMap () { return { source: content, map: old.map() } },
                      updateHash (hash) { hash.update(content) },
                    }
                  })
                }
              }
            }
          )
        })

        log.debug(
          'Automatically injected git metadata (DD_GIT_REPOSITORY_URL: %s, DD_GIT_COMMIT_SHA: %s)',
          gitMetadata.repositoryURL || 'not available',
          gitMetadata.commitSHA || 'not available'
        )
      } else {
        log.warn('No git metadata available - skipping injection')
      }
    } else {
      log.debug('Skipping git metadata injection (DD_BUNDLER_INJECT_GIT_METADATA=false)')
    }

    compiler.hooks.normalModuleFactory.tap(PLUGIN_NAME, (nmf) => {
      nmf.hooks.afterResolve.tap(PLUGIN_NAME, (resolveData) => {
        const { createData } = resolveData
        const resource = createData?.resource
        if (!resource) {
          return
        }

        const normalizedResource = resource.replaceAll('\\', '/')

        if (!resource.includes('node_modules')) {
          return
        }

        const { pkg, path: modulePath, pkgJson } = extractPackageAndModulePath(normalizedResource)
        if (!pkg) {
          return
        }

        const request = resolveData.request
        const isModuleOfInterest = modulesOfInterest.has(request) || modulesOfInterest.has(`${pkg}/${modulePath}`)

        if (!isModuleOfInterest && getRewriteTarget(normalizedResource) === undefined) {
          return
        }

        if (!pkgJson) {
          return
        }

        let packageJson
        try {
          packageJson = JSON.parse(fs.readFileSync(pkgJson).toString())
        } catch (e) {
          if (e.code === 'ENOENT') {
            log.debug(
              'Skipping `package.json` lookup for %s. The package may be vendored.',
              pkg
            )
            return
          }
          throw e
        }

        if (isESMFile(normalizedResource, pkgJson, packageJson)) {
          log.warn('Skipping ESM module (ESM support is not available in the webpack plugin): %s', resource)
          return
        }

        const version = packageJson.version
        const pkgPath = request === pkg ? pkg : `${pkg}/${modulePath}`

        // Webpack runs loaders right-to-left, so appending makes this loader see the package's original source
        // before any user transpiler lowers the syntax Orchestrion function queries match on.
        createData.loaders ||= []
        createData.loaders.push({
          loader: require.resolve('./src/loader'),
          options: { pkg, version, path: pkgPath, rewriteOnly: !isModuleOfInterest },
        })

        log.debug('LOAD: %s@%s, pkg "%s"', pkg, version, pkgPath)
      })
    })
  }
}

module.exports = DatadogWebpackPlugin
