'use strict'

const { execSync } = require('node:child_process')
const fs = require('node:fs')

const instrumentations = require('../datadog-instrumentations/src/helpers/instrumentations')
const extractPackageAndModulePath = require('../datadog-instrumentations/src/helpers/extract-package-and-module-path')
const hooks = require('../datadog-instrumentations/src/helpers/hooks')
const createBundlerBanner = require('../datadog-instrumentations/src/helpers/bundler-banner')
const { getRewriteTarget } = require('../datadog-instrumentations/src/helpers/rewriter/targets')
const { isESMFile } = require('../datadog-esbuild/src/utils')
const { getValueFromEnvSources } = require('../dd-trace/src/config/helper')
const log = require('./src/log')

const PLUGIN_NAME = 'DatadogWebpackPlugin'
const JAVASCRIPT_ASSET = /\.[cm]?js$/
const WHITESPACE = /\s/

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

      if (!isNodeTarget(compiler.options.target)) {
        log.warn('Node.js built-in instrumentation may not work with webpack target %s', compiler.options.target)
      }
      if (compiler.options.externalsPresets?.node === false) {
        log.warn('externalsPresets.node is false; Node.js built-ins may be bundled instead of instrumented')
      }
    })

    // Bake DD_GIT_* into assets unless DD_BUNDLER_INJECT_GIT_METADATA=false (stable artifact hashes).
    let gitMetadataBanner = ''
    if (DD_BUNDLER_INJECT_GIT_METADATA) {
      const gitMetadata = getGitMetadata()
      if (gitMetadata.repositoryURL || gitMetadata.commitSHA) {
        gitMetadataBanner =
          'if (typeof process === \'object\' && process !== null &&\n' +
          '    process.env !== null && typeof process.env === \'object\') {\n' +
          (gitMetadata.repositoryURL
            ? `  process.env.DD_GIT_REPOSITORY_URL = ${JSON.stringify(gitMetadata.repositoryURL)};\n`
            : '') +
          (gitMetadata.commitSHA
            ? `  process.env.DD_GIT_COMMIT_SHA = ${JSON.stringify(gitMetadata.commitSHA)};\n`
            : '') +
          '}\n'

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

    // Node's ESM output has no CommonJS globals, but bundled tracer modules still use them.
    const esmBanner = compiler.options.output?.module
      ? 'import {createRequire as __dd_createRequire} from "node:module";' +
        'import {fileURLToPath as __dd_fileURLToPath} from "node:url";' +
        'const require=__dd_createRequire(import.meta.url);' +
        'const __filename=__dd_fileURLToPath(import.meta.url);' +
        'const __dirname=require("node:path").dirname(__filename);'
      : ''

    const banner = esmBanner + gitMetadataBanner + createBundlerBanner('webpack')

    compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
      compilation.hooks.processAssets.tap(
        { name: PLUGIN_NAME, stage: -2000 },
        () => {
          const updatedAssets = new Set()

          for (const chunk of compilation.chunks) {
            if (!chunk.canBeInitial()) continue
            for (const filename of chunk.files) {
              if (updatedAssets.has(filename) || !JAVASCRIPT_ASSET.test(filename)) continue
              updatedAssets.add(filename)
              compilation.updateAsset(filename, old => {
                // Code ahead of a leading "use strict" directive (e.g. with output.iife disabled) would turn it into
                // a plain expression and the whole asset into sloppy mode, so the banner goes after it.
                const { offset, code } = getBannerInsertion(old.source(), banner)
                const source = new compiler.webpack.sources.ReplaceSource(old)
                source.insert(offset, code)
                return source
              })
            }
          }
        }
      )
    })

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

/**
 * Places startup code where it cannot break the asset's prologue: after a leading "use strict" directive preceded
 * only by whitespace and comments, otherwise after a hashbang line, otherwise at the start.
 * @param {string | Buffer} source
 * @param {string} banner
 * @returns {{ offset: number, code: string }}
 */
function getBannerInsertion (source, banner) {
  if (typeof source !== 'string') return { offset: 0, code: banner }

  const start = source.startsWith('#!') ? (source.indexOf('\n') + 1 || source.length) : 0
  let index = start

  while (index < source.length) {
    if (WHITESPACE.test(source[index])) {
      index++
    } else if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2)
      if (end === -1) break
      index = end + 2
    } else if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2)
      if (end === -1) break
      index = end + 1
    } else {
      break
    }
  }

  if (!source.startsWith('"use strict"', index) && !source.startsWith("'use strict'", index)) {
    return { offset: start, code: banner }
  }
  index += '"use strict"'.length
  // Without its semicolon, the directive followed by `(` would become a call.
  return source[index] === ';' ? { offset: index + 1, code: banner } : { offset: index, code: `;${banner}` }
}

/**
 * @param {unknown} target
 */
function isNodeTarget (target) {
  if (Array.isArray(target)) return target.some(isNodeTarget)
  if (typeof target !== 'string') return false

  return /^(?:async-)?node(?:\d+(?:\.\d+)?)?$/.test(target) ||
    target === 'electron-main' || target === 'electron-preload' || target === 'nwjs'
}

module.exports = DatadogWebpackPlugin
