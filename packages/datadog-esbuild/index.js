'use strict'

const { execSync } = require('node:child_process')
const fs = require('node:fs')
const { builtinModules } = require('node:module')
const path = require('node:path')
const { pathToFileURL, fileURLToPath } = require('node:url')

const { createWrapperModule, getNodeModuleFormat } = require('import-in-the-middle/bundler')

const modulesOfInterest = require('../datadog-instrumentations/src/helpers/bundler-modules')
const extractPackageAndModulePath = require('../datadog-instrumentations/src/helpers/extract-package-and-module-path')
const {
  OPTIONAL_PEER_FILTER,
  matchesOptionalPeerFile,
  rewriteOptionalPeerLoads,
} = require('../datadog-instrumentations/src/helpers/optional-peer-bundler')
const log = require('./src/log')

const ESM_INTERCEPTED_SUFFIX = '._dd_esbuild_intercepted'
const INTERNAL_ESM_INTERCEPTED_PREFIX = '/_dd_esm_internal_/'

let rewriter

const builtins = new Set(builtinModules)

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

  // Keep the build from failing on the optional `@openfeature/core` peer of
  // `@openfeature/server-sdk` when it is not installed (#8635). esbuild follows the chain
  // whenever `@openfeature/server-sdk` is reachable -- the app importing it directly, or the
  // bundled provider when the optional peer is present -- so mark `@openfeature/core` external
  // when it is absent rather than erroring at bundle time.
  try {
    // eslint-disable-next-line n/no-unpublished-require
    require.resolve('@openfeature/core')
  } catch {
    build.initialOptions.external ??= []
    build.initialOptions.external.push('@openfeature/core')
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

  // Rewrite optional-peer loads so installed peers get bundled and survive the bundle being
  // relocated without them on disk (#8980). Registered before the generic onLoad so it wins for
  // these files. Absent peers stay opaque, so a build that does not opt into the feature does not
  // follow their dependency chain (#8635).
  build.onLoad({ filter: OPTIONAL_PEER_FILTER }, args => {
    const normalizedPath = args.path.replaceAll('\\', '/')
    if (!matchesOptionalPeerFile(normalizedPath)) return

    log.debug('INLINE: optional-peer loader applied to %s', normalizedPath)
    return {
      contents: rewriteOptionalPeerLoads(fs.readFileSync(args.path, 'utf8'), path.dirname(args.path)),
      loader: 'js',
      resolveDir: path.dirname(args.path),
    }
  })

  // first time is intercepted, proxy should be created, next time the original should be loaded
  const interceptedESMModules = new Set()
  const wrapperImports = new Map()

  build.onResolve({ filter: /.*/ }, args => {
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
    if (!modulesOfInterest.has(args.path) &&
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

    const extracted = extractPackageAndModulePath(fullPathToModule)

    const internal = args.path.startsWith('node:') || builtins.has(args.path)

    if (args.namespace === 'file' && (
      modulesOfInterest.has(args.path) || modulesOfInterest.has(`${extracted.pkg}/${extracted.path}`))
    ) {
      // Internal module like http/fs is imported and the build output is ESM
      if (internal && args.kind === 'import-statement' && esmBuild && !interceptedESMModules.has(fullPathToModule)) {
        fullPathToModule = `${INTERNAL_ESM_INTERCEPTED_PREFIX}${fullPathToModule}${ESM_INTERCEPTED_SUFFIX}`

        return {
          path: fullPathToModule,
          sideEffects: true,
          pluginData: {
            pkg: extracted?.pkg,
            path: extracted?.path,
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
      // The file namespace is used when requiring files from disk in userland
      if (extracted.pkg === null) return

      let pathToPackageJson
      try {
        // we can't use require.resolve('pkg/package.json') as ESM modules don't make the file available
        pathToPackageJson = require.resolve(extracted.pkg, { paths: [args.resolveDir] })
        pathToPackageJson = extractPackageAndModulePath(pathToPackageJson).pkgJson
      } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') {
          if (!internal) {
            log.warn(
              'Unable to find "%s/package.json". Unless it\'s dead code this could cause a problem at runtime.',
              extracted.pkg
            )
          }
          return
        }
        throw err
      }

      try {
        const packageJson = JSON.parse(fs.readFileSync(/** @type {string} */(pathToPackageJson)).toString())

        const format = getNodeModuleFormat(
          pathToFileURL(fullPathToModule).href,
          pathToFileURL(pathToPackageJson).href,
          packageJson.type
        ) ?? 'commonjs'
        const isESM = format === 'module' || format === 'module-typescript'
        if (isESM && !interceptedESMModules.has(fullPathToModule)) {
          fullPathToModule += ESM_INTERCEPTED_SUFFIX
        }

        log.debug('RESOLVE: %s@%s', args.path, packageJson.version)

        // https://esbuild.github.io/plugins/#on-resolve-arguments
        return {
          path: fullPathToModule,
          sideEffects: true,
          pluginData: {
            version: packageJson.version,
            pkg: extracted.pkg,
            path: extracted.path,
            full: fullPathToModule,
            raw: args.path,
            pkgOfInterest: true,
            kind: args.kind,
            internal,
            isESM,
            format,
          },
        }
      } catch (e) {
        // Skip vendored dependencies which never have a `package.json`. This
        // will use the default resolve logic of ESBuild which is what we want
        // since those files should be treated as regular files and not modules
        // even though they are in a `node_modules` folder.
        if (e.code === 'ENOENT') {
          log.debug(
            // eslint-disable-next-line @stylistic/max-len
            'Skipping `package.json` lookup. This usually means the package was vendored but could indicate an issue otherwise.'
          )
        } else {
          throw e
        }
      }
    }
  })

  build.onLoad({ filter: /.*/ }, async args => {
    if (args.pluginData?.pkgOfInterest) {
      const data = args.pluginData
      const wrapperPath = args.path

      log.debug('LOAD: %s@%s, pkg "%s"', data.pkg, data.version, data.path)

      if (data.isESM && !args.path.endsWith(ESM_INTERCEPTED_SUFFIX)) {
        return {
          contents: fs.readFileSync(args.path, 'utf8'),
          loader: 'js',
          resolveDir: path.dirname(args.path),
        }
      }

      if (data.isESM) {
        args.path = args.path.slice(0, -ESM_INTERCEPTED_SUFFIX.length)
        if (data.internal) args.path = args.path.slice(INTERNAL_ESM_INTERCEPTED_PREFIX.length)
        interceptedESMModules.add(args.path)
      }

      /**
       * @param {string} specifier
       * @param {{ parentURL?: string }} context
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
          format: getNodeModuleFormat(url) ?? 'commonjs',
          watchFiles: path.isAbsolute(result.path) ? [pathToFileURL(result.path).href] : undefined,
        }
      }

      /**
       * @param {string} url
       * @param {{ format?: string }} context
       */
      const loadModule = (url, context) => {
        if (!url.startsWith('file:')) return { format: context.format }

        const filename = fileURLToPath(url)
        return {
          source: fs.readFileSync(filename),
          format: context.format ?? getNodeModuleFormat(url) ?? 'commonjs',
          watchFiles: [url],
        }
      }

      const moduleUrl = data.internal ? args.path : pathToFileURL(args.path).href
      const wrapper = await createWrapperModule({
        module: {
          url: moduleUrl,
          format: data.format,
          source: data.internal ? undefined : fs.readFileSync(args.path),
          specifier: data.raw,
          data: { version: data.version },
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
        resolveDir: data.internal ? process.cwd() : path.dirname(args.path),
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
