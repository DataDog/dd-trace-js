'use strict'

const { execSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const { getBundlerTarget } = require('../datadog-instrumentations/src/helpers/bundler-target')
const wrapperLoader = require('./src/loader')
const log = require('./src/log')

const PLUGIN_NAME = 'DatadogWebpackPlugin'

/**
 * @typedef {object} ResolveData
 * @property {{ loaders?: object[], resource?: string, settings: { sideEffects?: boolean } }} [createData]
 * @property {string} [request]
 */

/**
 * @returns {{ repositoryURL: string | null, commitSHA: string | null }}
 */
function getGitMetadata () {
  const gitMetadata = {
    repositoryURL: null,
    commitSHA: null,
  }

  try {
    gitMetadata.repositoryURL = execSync('git config --get remote.origin.url', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      cwd: process.cwd(),
    }).trim()
  } catch (e) {
    log.warn('failed to get git repository URL:', e.message)
  }

  try {
    gitMetadata.commitSHA = execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      cwd: process.cwd(),
    }).trim()
  } catch (e) {
    log.warn('failed to get git commit SHA:', e.message)
  }

  return gitMetadata
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

    const gitMetadata = getGitMetadata()
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

    compiler.hooks.normalModuleFactory.tap(PLUGIN_NAME, (nmf) => {
      nmf.hooks.afterResolve.tap(PLUGIN_NAME, /** @param {ResolveData} resolveData */ (resolveData) => {
        const { createData } = resolveData
        const resource = createData?.resource
        if (!resource) {
          return
        }
        if (resource.endsWith(wrapperLoader.ORIGINAL_QUERY)) return

        const request = resolveData.request
        if (!request) return

        const url = pathToFileURL(resource).href
        const target = getBundlerTarget(request, url)
        if (target === undefined) return

        createData.loaders ||= []
        createData.loaders.unshift({
          loader: require.resolve('./src/loader'),
          options: {
            format: target.format,
            moduleName: target.moduleName,
            specifier: target.package,
            url: target.url,
            version: target.version,
          },
        })
        createData.settings.sideEffects = true

        log.debug('LOAD: %s@%s, pkg "%s"', target.package, target.version, target.path)
      })
    })
  }
}

module.exports = DatadogWebpackPlugin
