'use strict'

const { execSync } = require('node:child_process')
const fs = require('node:fs')
const { builtinModules } = require('node:module')
const path = require('node:path')
const { fileURLToPath, pathToFileURL } = require('node:url')

const { createWrapperModule, getNodeModuleFormat } = require('import-in-the-middle/bundler')

const {
  getBundlerTarget,
  isPackageOfInterest,
} = require('../datadog-instrumentations/src/helpers/bundler-target')
const log = require('./src/log')

const ESM_INTERCEPTED_SUFFIX = '._dd_esbuild_intercepted'
const INTERNAL_ESM_INTERCEPTED_PREFIX = '/_dd_esm_internal_/'

let rewriter

const builtinModuleNames = new Set(builtinModules)

const builtins = new Set()

for (const builtin of builtinModuleNames) {
  builtins.add(builtin)
  builtins.add(`node:${builtin}`)
}

// eslint-disable-next-line eslint-rules/eslint-process-env
const DD_IAST_ENABLED = process.env.DD_IAST_ENABLED?.toLowerCase() === 'true' || process.env.DD_IAST_ENABLED === '1'

module.exports.name = 'datadog-esbuild'

function isESMBuild (build) {
  // check toLowerCase? to be safe if unexpected object is there instead of a string
  const format = build.initialOptions.format?.toLowerCase?.()
  const outputFile = build.initialOptions.outfile?.toLowerCase?.()
  const outExtension = build.initialOptions.outExtension?.['.js']
  return format === 'esm' || outputFile?.endsWith('.mjs') || outExtension === '.mjs'
}

function getGitMetadata () {
  /**
   * @type {object}
   * @property {string | null} repositoryURL
   * @property {string | null} commitSHA
   */
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
 * @param {import('esbuild').PluginBuild} build
 */
module.exports.setup = function (build) {
  if (build.initialOptions.minify && !build.initialOptions.keepNames) {
    throw new Error(
      'Using --minify without --keep-names will break some dd-trace behavior. Refusing to bundle.'
    )
  }

  if (DD_IAST_ENABLED) {
    const iastRewriter = require('../dd-trace/src/appsec/iast/taint-tracking/rewriter')
    rewriter = iastRewriter.getRewriter()
  }

  const isSourceMapEnabled = !!build.initialOptions.sourcemap ||
    ['internal', 'both'].includes(build.initialOptions.sourcemap)
  const externalModules = new Set(build.initialOptions.external || [])
  build.initialOptions.banner ??= {}
  build.initialOptions.banner.js ??= ''
  if (DD_IAST_ENABLED) {
    build.initialOptions.banner.js =
      `globalThis.__DD_ESBUILD_IAST_${isSourceMapEnabled ? 'WITH_SM' : 'WITH_NO_SM'} = true;
      ${isSourceMapEnabled ? `globalThis.__DD_ESBUILD_BASEPATH = '${require('../dd-trace/src/util').ddBasePath}';` : ''}
${build.initialOptions.banner.js}`
  }

  const esmBuild = isESMBuild(build)
  if (
    esmBuild &&
    !build.initialOptions.banner.js.includes('import { createRequire as $dd_createRequire } from \'module\'')
  ) {
    build.initialOptions.banner.js = `import { createRequire as $dd_createRequire } from 'module';
import { fileURLToPath as $dd_fileURLToPath } from 'url';
import { dirname as $dd_dirname } from 'path';
globalThis.require ??= $dd_createRequire(import.meta.url);
globalThis.__filename ??= $dd_fileURLToPath(import.meta.url);
globalThis.__dirname ??= $dd_dirname(globalThis.__filename);
${build.initialOptions.banner.js}`
  }

  // Get git metadata at build time and add it to the banner for both ESM and CommonJS builds
  const gitMetadata = getGitMetadata()
  if (gitMetadata.repositoryURL || gitMetadata.commitSHA) {
    build.initialOptions.banner ??= {}
    build.initialOptions.banner.js ??= ''

    build.initialOptions.banner.js = `if (typeof process === 'object' && process !== null &&
    process.env !== null && typeof process.env === 'object') {
  ${gitMetadata.repositoryURL ? `process.env.DD_GIT_REPOSITORY_URL = '${gitMetadata.repositoryURL}';` : ''}
  ${gitMetadata.commitSHA ? `process.env.DD_GIT_COMMIT_SHA = '${gitMetadata.commitSHA}';` : ''}
}
${build.initialOptions.banner.js}`

    log.debug(
      'Automatically injected git metadata (DD_GIT_REPOSITORY_URL: %s, DD_GIT_COMMIT_SHA: %s)',
      gitMetadata.repositoryURL || 'not available',
      gitMetadata.commitSHA || 'not available'
    )
  } else {
    log.warn('No git metadata available - skipping injection')
  }

  const wrapperImports = new Map()

  build.onResolve({ filter: /.*/ }, /** @param {import('esbuild').OnResolveArgs} args */ args => {
    const imports = wrapperImports.get(args.importer)
    const wrapperImport = imports?.get(args.path)
    if (wrapperImport !== undefined) {
      imports.delete(args.path)
      if (imports.size === 0) wrapperImports.delete(args.importer)

      const { target } = wrapperImport
      return {
        path: target.url.startsWith('file:') ? fileURLToPath(target.url) : target.url,
        external: wrapperImport.external,
        sideEffects: true,
      }
    }

    if (args.pluginData?.skipDatadogInstrumentation) return

    if (externalModules.has(args.path)) {
      // Internal Node.js packages will still be instrumented via require()
      log.debug('EXTERNAL: %s', args.path)
      return
    }

    // TODO: Should this also check for namespace === 'file'?
    if (!isPackageOfInterest(args.path) &&
        args.path.startsWith('@') &&
        !args.importer.includes('node_modules/')) {
      // This is the Next.js convention for loading local files
      log.debug('@LOCAL: %s', args.path)
      return
    }

    let fullPathToModule
    try {
      fullPathToModule = dotFriendlyResolve(args.path, args.resolveDir, args.kind === 'import-statement')
    } catch {
      log.warn('Unable to find "%s". Unless it\'s dead code this could cause a problem at runtime.', args.path)
      return
    }

    if (args.path.startsWith('.') && !args.importer.includes('node_modules/')) {
      // It is local application code, not an instrumented package
      log.debug('APP: %s', args.path)

      return {
        path: fullPathToModule,
        pluginData: {
          path: args.path,
          full: fullPathToModule,
          applicationFile: true,
        },
      }
    }

    const internal = builtins.has(args.path)
    if (internal && (args.kind !== 'import-statement' || !esmBuild)) return

    const target = getBundlerTarget(
      args.path,
      internal ? args.path : pathToFileURL(fullPathToModule).href
    )

    if (args.namespace === 'file' && target !== undefined) {
      // Internal module like http/fs is imported and the build output is ESM
      if (internal) {
        fullPathToModule = `${INTERNAL_ESM_INTERCEPTED_PREFIX}${fullPathToModule}${ESM_INTERCEPTED_SUFFIX}`

        return {
          path: fullPathToModule,
          sideEffects: true,
          pluginData: {
            moduleName: target.moduleName,
            pkg: target.package,
            path: target.path,
            full: fullPathToModule,
            raw: args.path,
            pkgOfInterest: true,
            kind: args.kind,
            internal,
            isESM: true,
            format: 'builtin',
          },
        }
      }

      const isESM = target.format === 'module' || target.format === 'module-typescript'
      if (isESM) fullPathToModule += ESM_INTERCEPTED_SUFFIX

      log.debug('RESOLVE: %s@%s', args.path, target.version)

      // https://esbuild.github.io/plugins/#on-resolve-arguments
      return {
        path: fullPathToModule,
        sideEffects: true,
        pluginData: {
          version: target.version,
          moduleName: target.moduleName,
          pkg: target.package,
          path: target.path,
          full: fullPathToModule,
          raw: args.path,
          pkgOfInterest: true,
          kind: args.kind,
          internal,
          isESM,
          format: target.format,
        },
      }
    }
  })

  build.onLoad({ filter: /.*/ }, /** @param {import('esbuild').OnLoadArgs} args */ async args => {
    if (args.pluginData?.pkgOfInterest) {
      const data = args.pluginData
      const wrapperPath = args.path

      log.debug('LOAD: %s@%s, pkg "%s"', data.pkg, data.version, data.path)

      if (data.isESM) {
        args.path = args.path.slice(0, -ESM_INTERCEPTED_SUFFIX.length)
        if (data.internal) args.path = args.path.slice(INTERNAL_ESM_INTERCEPTED_PREFIX.length)
      }

      /**
       * @param {string} specifier
       * @param {{ parentURL?: string }} context
       * @returns {Promise<{ url: string, format: string, watchFiles?: string[] }>}
       */
      const resolveModule = async (specifier, context) => {
        if (specifier.startsWith('node:') || builtins.has(specifier)) {
          return { url: specifier, format: 'builtin' }
        }

        const importer = context.parentURL?.startsWith('file:')
          ? fileURLToPath(context.parentURL)
          : ''
        const result = await build.resolve(specifier, {
          importer,
          namespace: 'file',
          resolveDir: importer ? path.dirname(importer) : process.cwd(),
          kind: 'import-statement',
          pluginData: { skipDatadogInstrumentation: true },
        })
        if (result.errors.length > 0) throw new Error(result.errors[0].text)

        const builtin = result.path.startsWith('node:') || builtins.has(result.path)
        const url = builtin ? result.path : pathToFileURL(result.path).href
        return {
          url,
          format: builtin ? 'builtin' : getNodeModuleFormat(url),
          watchFiles: path.isAbsolute(result.path) ? [pathToFileURL(result.path).href] : undefined,
        }
      }

      /**
       * @param {string} url
       * @param {{ format?: string }} context
       * @returns {{ source?: Buffer, format?: string, watchFiles?: string[] }}
       */
      const loadModule = (url, context) => {
        if (!url.startsWith('file:')) return { format: context.format }

        const filename = fileURLToPath(url)
        return {
          source: fs.readFileSync(filename),
          format: context.format ?? getNodeModuleFormat(url),
          watchFiles: [url],
        }
      }

      const moduleUrl = data.internal ? args.path : pathToFileURL(args.path).href
      const wrapper = await createWrapperModule({
        module: {
          url: moduleUrl,
          format: data.format,
          source: data.internal ? undefined : fs.readFileSync(args.path),
          specifier: data.internal ? data.raw : data.pkg,
          data: { moduleName: data.moduleName, version: data.version },
        },
        resolve: resolveModule,
        load: loadModule,
      })
      const imports = new Map()
      for (const entry of wrapper.imports) imports.set(entry.specifier, entry)
      wrapperImports.set(wrapperPath, imports)

      const watchFiles = []
      for (const watchFile of wrapper.watchFiles) {
        if (watchFile.startsWith('file:')) watchFiles.push(fileURLToPath(watchFile))
      }

      return {
        contents: wrapper.code,
        loader: 'js',
        resolveDir: data.internal
          ? build.initialOptions.absWorkingDir ?? process.cwd()
          : path.dirname(args.path),
        watchFiles,
      }
    }
    if (DD_IAST_ENABLED && args.pluginData?.applicationFile) {
      const ext = path.extname(args.path).toLowerCase()
      const isJs = /^\.(js|mjs|cjs)$/.test(ext)
      if (!isJs) return

      log.debug('REWRITE: %s', args.path)
      const fileCode = fs.readFileSync(args.path, 'utf8')
      const rewritten = rewriter.rewrite(fileCode, args.path, ['iast'])
      return {
        contents: rewritten.content,
        loader: 'js',
        resolveDir: path.dirname(args.path),
      }
    }
  })
}

// @see https://github.com/nodejs/node/issues/47000
function dotFriendlyResolve (path, directory, usesImportStatement) {
  if (path === '.') {
    path = './'
  } else if (path === '..') {
    path = '../'
  }
  let conditions
  if (usesImportStatement) {
    conditions = new Set(['import', 'node'])
  }

  if (path.startsWith('file://')) {
    path = fileURLToPath(path)
  }
  return require.resolve(path, {
    paths: [directory],
    // @ts-expect-error - Node.js 22+ unofficially supports a conditions option
    conditions,
  })
}
