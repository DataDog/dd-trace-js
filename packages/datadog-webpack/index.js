'use strict'

const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const instrumentations = require('../datadog-instrumentations/src/helpers/instrumentations')
const extractPackageAndModulePath = require('../datadog-instrumentations/src/helpers/extract-package-and-module-path')
const hooks = require('../datadog-instrumentations/src/helpers/hooks')
const { matchesOptionalPeerFile } = require('../datadog-instrumentations/src/helpers/optional-peer-bundler')
const {
  createApplicationOtelApiPackageResolver,
} = require('../datadog-instrumentations/src/helpers/otel-api-externals')
const { isESMFile } = require('../datadog-esbuild/src/utils')
const log = require('./src/log')

const PLUGIN_NAME = 'DatadogWebpackPlugin'
const OTEL_API_HOLDER_PATH = require.resolve('../dd-trace/src/opentelemetry/api').replaceAll('\\', '/')
const OTEL_API_HOLDER_DIRECTORY = path.posix.dirname(OTEL_API_HOLDER_PATH)
const OTEL_API_PACKAGES = new Set(['@opentelemetry/api', '@opentelemetry/api-logs'])
const OTEL_API_PACKAGE_PATTERN = /^(@opentelemetry\/api(?:-logs)?)(?:\/.*)?$/

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

/**
 * @param {unknown} request
 * @returns {string | undefined}
 */
function getOtelApiPackageName (request) {
  if (typeof request !== 'string') return
  return OTEL_API_PACKAGE_PATTERN.exec(request)?.[1]
}

/**
 * Prevent user externals from overriding the OpenTelemetry API decision made by this plugin.
 *
 * @param {unknown} external
 * @returns {unknown}
 */
function withoutOtelApiExternals (external) {
  if (typeof external === 'string') {
    return getOtelApiPackageName(external) ? undefined : external
  }

  if (Array.isArray(external)) {
    const filtered = []
    for (const value of external) {
      const filteredValue = withoutOtelApiExternals(value)
      if (filteredValue !== undefined) filtered.push(filteredValue)
    }
    return filtered
  }

  if (external instanceof RegExp) {
    return ({ request }, callback) => {
      if (getOtelApiPackageName(request)) return callback()
      callback(null, external.test(request) ? request : undefined)
    }
  }

  if (typeof external === 'function') {
    if (external.length === 3) {
      return (context, request, callback) => {
        if (getOtelApiPackageName(request)) return callback()
        return external(context, request, callback)
      }
    }

    return (data, callback) => {
      if (getOtelApiPackageName(data.request)) return callback()
      return external(data, callback)
    }
  }

  if (external !== null && typeof external === 'object') {
    const filtered = {}
    for (const [request, value] of Object.entries(external)) {
      if (getOtelApiPackageName(request)) continue
      if (request === 'byLayer' && value !== null && typeof value === 'object') {
        const layers = {}
        for (const [layer, layerExternal] of Object.entries(value)) {
          layers[layer] = withoutOtelApiExternals(layerExternal)
        }
        filtered[request] = layers
      } else {
        filtered[request] = value
      }
    }
    return filtered
  }

  // Preserve external types added by future Webpack versions.
  /* istanbul ignore next */
  return external
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

    const workingDirectory = compiler.options.context || process.cwd()
    const resolveApplicationOtelApiPackages = createApplicationOtelApiPackageResolver(workingDirectory)
    const outputModule = compiler.options.experiments?.outputModule || compiler.options.output?.module
    const externalType = outputModule ? 'node-commonjs' : 'commonjs'
    /**
     * @param {{ context?: string, request?: string }} data
     * @param {(error?: Error | null, result?: string | boolean) => void} callback
     */
    const otelApiExternal = ({ context, request }, callback) => {
      const packageName = getOtelApiPackageName(request)
      if (!packageName) return callback()
      if (context?.replaceAll('\\', '/') === OTEL_API_HOLDER_DIRECTORY) return callback(null, false)
      if (resolveApplicationOtelApiPackages(context).has(packageName)) {
        return callback(null, `${externalType} ${request}`)
      }
      callback(null, false)
    }
    const configuredExternals = Array.isArray(compiler.options.externals)
      ? compiler.options.externals
      : [compiler.options.externals].filter(Boolean)
    const externals = [otelApiExternal]
    for (const external of configuredExternals) {
      const filtered = withoutOtelApiExternals(external)
      if (filtered !== undefined) externals.push(filtered)
    }
    compiler.options.externals = externals

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
      nmf.hooks.afterResolve.tap(PLUGIN_NAME, (resolveData) => {
        const { createData } = resolveData
        const resource = createData?.resource
        if (!resource) {
          return
        }

        const normalizedResource = resource.replaceAll('\\', '/')

        // Rewrite optional-peer loads so installed peers get bundled and survive relocation
        // (#8980); absent peers stay opaque, so a build that does not opt into the feature does
        // not follow their dependency chain (#8635).
        if (matchesOptionalPeerFile(normalizedResource)) {
          createData.loaders = createData.loaders || []
          createData.loaders.push({ loader: require.resolve('./src/optional-peer-loader') })
          log.debug('INLINE: optional-peer loader applied to %s', normalizedResource)
          return
        }

        if (!resource.includes('node_modules')) {
          return
        }

        const { pkg, path: modulePath, pkgJson } = extractPackageAndModulePath(normalizedResource)
        if (!pkg) {
          return
        }

        const request = resolveData.request

        if (!modulesOfInterest.has(request) && !modulesOfInterest.has(`${pkg}/${modulePath}`)) {
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
        const moduleBaseDir = path.dirname(pkgJson).replaceAll('\\', '/')
        const issuer = resolveData.contextInfo?.issuer?.replaceAll('\\', '/')
        const applicationPackage = resolveApplicationOtelApiPackages(
          issuer && path.posix.dirname(issuer)
        ).get(pkg)
        const applicationOwned = issuer !== OTEL_API_HOLDER_PATH &&
          applicationPackage?.moduleBaseDir === moduleBaseDir

        // The fallback API is consumed directly by the holder and does not need a hook publish.
        // Skipping its loader also lets Webpack bundle the package's ESM entrypoint unchanged.
        if (OTEL_API_PACKAGES.has(pkg) && !applicationOwned) return

        createData.loaders = createData.loaders || []
        createData.loaders.unshift({
          loader: require.resolve('./src/loader'),
          options: { applicationOwned, moduleBaseDir, pkg, version, path: pkgPath },
        })

        log.debug('LOAD: %s@%s, pkg "%s"', pkg, version, pkgPath)
      })
    })
  }
}

module.exports = DatadogWebpackPlugin
