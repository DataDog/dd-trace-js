'use strict'

const { execSync } = require('node:child_process')
const fs = require('node:fs')
const RAW_BUILTINS = require('node:module').builtinModules
const path = require('node:path')
const { pathToFileURL, fileURLToPath } = require('node:url')

const instrumentations = require('../datadog-instrumentations/src/helpers/instrumentations')
const extractPackageAndModulePath = require('../datadog-instrumentations/src/helpers/extract-package-and-module-path')
const hooks = require('../datadog-instrumentations/src/helpers/hooks')
const { processModule, isESMFile } = require('./src/utils')
const log = require('./src/log')

const ESM_INTERCEPTED_SUFFIX = '._dd_esbuild_intercepted'
const INTERNAL_ESM_INTERCEPTED_PREFIX = '/_dd_esm_internal_/'

let rewriter

for (const hook of Object.values(hooks)) {
  if (hook !== null && typeof hook === 'object') {
    hook.fn()
  } else {
    hook()
  }
}

const modulesOfInterest = new Set()

for (const instrumentation of Object.values(instrumentations)) {
  for (const entry of instrumentation) {
    if (entry.file) {
      modulesOfInterest.add(`${entry.name}/${entry.file}`) // e.g. "redis/my/file.js"
    } else {
      modulesOfInterest.add(entry.name) // e.g. "redis"
    }
  }
}

const CHANNEL = 'dd-trace:bundler:load'

const builtins = new Set()

for (const builtin of RAW_BUILTINS) {
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

  // first time is intercepted, proxy should be created, next time the original should be loaded
  const interceptedESMModules = new Set()

  build.onResolve({ filter: /.*/ }, args => {
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

    const internal = builtins.has(args.path)

    if (args.namespace === 'file' && (
      modulesOfInterest.has(args.path) || modulesOfInterest.has(`${extracted.pkg}/${extracted.path}`))
    ) {
      // Internal module like http/fs is imported and the build output is ESM
      if (internal && args.kind === 'import-statement' && esmBuild && !interceptedESMModules.has(fullPathToModule)) {
        fullPathToModule = `${INTERNAL_ESM_INTERCEPTED_PREFIX}${fullPathToModule}${ESM_INTERCEPTED_SUFFIX}`

        return {
          path: fullPathToModule,
          pluginData: {
            pkg: extracted?.pkg,
            path: extracted?.path,
            full: fullPathToModule,
            raw: args.path,
            pkgOfInterest: true,
            kind: args.kind,
            internal,
            isESM: true,
          },
        }
      }
      // The file namespace is used when requiring files from disk in userland
      let pathToPackageJson
      try {
        // we can't use require.resolve('pkg/package.json') as ESM modules don't make the file available
        pathToPackageJson = require.resolve(`${extracted.pkg}`, { paths: [args.resolveDir] })
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
        const packageJson = JSON.parse(fs.readFileSync(pathToPackageJson).toString())

        const isESM = isESMFile(fullPathToModule, pathToPackageJson, packageJson)
        if (isESM && !interceptedESMModules.has(fullPathToModule)) {
          fullPathToModule += ESM_INTERCEPTED_SUFFIX
        }

        log.debug('RESOLVE: %s@%s', args.path, packageJson.version)

        // https://esbuild.github.io/plugins/#on-resolve-arguments
        return {
          path: fullPathToModule,
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

      log.debug('LOAD: %s@%s, pkg "%s"', data.pkg, data.version, data.path)

      const pkgPath = data.raw === data.pkg
        ? data.pkg
        : `${data.pkg}/${data.path}`

      // Read the content of the module file of interest
      let contents

      if (data.isESM) {
        if (args.path.endsWith(ESM_INTERCEPTED_SUFFIX)) {
          args.path = args.path.slice(0, -1 * ESM_INTERCEPTED_SUFFIX.length)

          if (data.internal) {
            args.path = args.path.slice(INTERNAL_ESM_INTERCEPTED_PREFIX.length)
          }

          interceptedESMModules.add(args.path)

          const setters = await processModule({
            path: args.path,
            internal: data.internal,
            context: { format: 'module' },
          })

          const iitmPath = require.resolve('import-in-the-middle/lib/register.js')
          const toRegister = data.internal ? args.path : pathToFileURL(args.path)
          // Mimic a Module object (https://tc39.es/ecma262/#sec-module-namespace-objects).
          contents = `
import { register } from ${JSON.stringify(iitmPath)};
import * as namespace from ${JSON.stringify(args.path)};
const _ = Object.create(null, { [Symbol.toStringTag]: { value: 'Module' } });
const set = {};
const get = {};

${[...setters.values()].join(';\n')};

register(${JSON.stringify(toRegister)}, _, set, get, ${JSON.stringify(data.raw)});
`
        } else {
          contents = fs.readFileSync(args.path, 'utf8')
        }
      } else {
        const fileCode = fs.readFileSync(args.path, 'utf8')
        contents = `
        (function() {
          ${fileCode}
        })(...arguments);
        {
          const dc = require('dc-polyfill');
          const ch = dc.channel('${CHANNEL}');
          const mod = module.exports
          const payload = {
            module: mod,
            version: '${data.version}',
            package: '${data.pkg}',
            path: '${pkgPath}'
          };
          ch.publish(payload);
          module.exports = payload.module;
      }
      `
      }

      // https://esbuild.github.io/plugins/#on-load-results
      return {
        contents,
        loader: 'js',
        resolveDir: path.dirname(args.path),
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
  return require.resolve(path, { paths: [directory], conditions })
}
