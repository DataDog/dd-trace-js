'use strict'

/* eslint-disable no-console */

const instrumentations = require('../datadog-instrumentations/src/helpers/instrumentations.js')
const hooks = require('../datadog-instrumentations/src/helpers/hooks.js')
const extractPackageAndModulePath = require(
  '../datadog-instrumentations/src/helpers/extract-package-and-module-path.js'
)

let rewriter

for (const hook of Object.values(hooks)) {
  if (typeof hook === 'object') {
    hook.fn()
  } else {
    hook()
  }
}

const modulesOfInterest = new Set()

for (const instrumentation of Object.values(instrumentations)) {
  for (const entry of instrumentation) {
    if (!entry.file) {
      modulesOfInterest.add(entry.name) // e.g. "redis"
    } else {
      modulesOfInterest.add(`${entry.name}/${entry.file}`) // e.g. "redis/my/file.js"
    }
  }
}

const INSTRUMENTED = Object.keys(instrumentations)
const RAW_BUILTINS = require('module').builtinModules
const CHANNEL = 'dd-trace:bundler:load'
const path = require('path')
const fs = require('fs')
const { execSync } = require('child_process')

const builtins = new Set()

for (const builtin of RAW_BUILTINS) {
  builtins.add(builtin)
  builtins.add(`node:${builtin}`)
}

const DEBUG = !!process.env.DD_TRACE_DEBUG
const DD_IAST_ENABLED = process.env.DD_IAST_ENABLED?.toLowerCase() === 'true' || process.env.DD_IAST_ENABLED === '1'

// We don't want to handle any built-in packages
// Those packages will still be handled via RITM
// Attempting to instrument them would fail as they have no package.json file
for (const pkg of INSTRUMENTED) {
  if (builtins.has(pkg) || pkg.startsWith('node:')) continue
  modulesOfInterest.add(pkg)
}

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
    commitSHA: null
  }

  try {
    gitMetadata.repositoryURL = execSync('git config --get remote.origin.url', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      cwd: process.cwd()
    }).trim()
  } catch (e) {
    if (DEBUG) {
      console.warn('Warning: failed to get git repository URL:', e.message)
    }
  }

  try {
    gitMetadata.commitSHA = execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      cwd: process.cwd()
    }).trim()
  } catch (e) {
    if (DEBUG) {
      console.warn('Warning: failed to get git commit SHA:', e.message)
    }
  }

  return gitMetadata
}

module.exports.setup = function (build) {
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
  if (isESMBuild(build)) {
    if (!build.initialOptions.banner.js.includes('import { createRequire as $dd_createRequire } from \'module\'')) {
      build.initialOptions.banner.js = `import { createRequire as $dd_createRequire } from 'module';
import { fileURLToPath as $dd_fileURLToPath } from 'url';
import { dirname as $dd_dirname } from 'path';
globalThis.require ??= $dd_createRequire(import.meta.url);
globalThis.__filename ??= $dd_fileURLToPath(import.meta.url);
globalThis.__dirname ??= $dd_dirname(globalThis.__filename);
${build.initialOptions.banner.js}`
    }
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

    if (DEBUG) {
      console.log('Info: automatically injected git metadata:')
      console.log(`DD_GIT_REPOSITORY_URL: ${gitMetadata.repositoryURL || 'not available'}`)
      console.log(`DD_GIT_COMMIT_SHA: ${gitMetadata.commitSHA || 'not available'}`)
    }
  } else if (DEBUG) {
    console.warn('Warning: No git metadata available - skipping injection')
  }

  build.onResolve({ filter: /.*/ }, args => {
    if (externalModules.has(args.path)) {
      // Internal Node.js packages will still be instrumented via require()
      if (DEBUG) console.log(`EXTERNAL: ${args.path}`)
      return
    }

    // TODO: Should this also check for namespace === 'file'?
    if (!modulesOfInterest.has(args.path) &&
        args.path.startsWith('@') &&
        !args.importer.includes('node_modules/')) {
      // This is the Next.js convention for loading local files
      if (DEBUG) console.log(`@LOCAL: ${args.path}`)
      return
    }

    let fullPathToModule
    try {
      fullPathToModule = dotFriendlyResolve(args.path, args.resolveDir)
    } catch (err) {
      if (DEBUG) {
        console.warn(`Warning: Unable to find "${args.path}".` +
          "Unless it's dead code this could cause a problem at runtime.")
      }
      return
    }

    if (args.path.startsWith('.') && !args.importer.includes('node_modules/')) {
      // It is local application code, not an instrumented package
      if (DEBUG) console.log(`APP: ${args.path}`, args)

      return {
        path: fullPathToModule,
        pluginData: {
          path: args.path,
          full: fullPathToModule,
          applicationFile: true
        }
      }
    }

    const extracted = extractPackageAndModulePath(fullPathToModule)

    const internal = builtins.has(args.path)

    if (args.namespace === 'file' && (
      modulesOfInterest.has(args.path) || modulesOfInterest.has(`${extracted.pkg}/${extracted.path}`))
    ) {
      // The file namespace is used when requiring files from disk in userland

      let pathToPackageJson
      try {
        // we can't use require.resolve('pkg/package.json') as ESM modules don't make the file available
        pathToPackageJson = require.resolve(`${extracted.pkg}`, { paths: [args.resolveDir] })
        pathToPackageJson = extractPackageAndModulePath(pathToPackageJson).pkgJson
      } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') {
          if (!internal) {
            if (DEBUG) {
              console.warn(`Warning: Unable to find "${extracted.pkg}/package.json".` +
              "Unless it's dead code this could cause a problem at runtime.")
            }
          }
          return
        } else {
          throw err
        }
      }

      const packageJson = JSON.parse(fs.readFileSync(pathToPackageJson).toString())

      if (DEBUG) console.log(`RESOLVE: ${args.path}@${packageJson.version}`)

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
          internal
        }
      }
    }
  })

  build.onLoad({ filter: /.*/ }, args => {
    if (args.pluginData?.pkgOfInterest) {
      const data = args.pluginData

      if (DEBUG) console.log(`LOAD: ${data.pkg}@${data.version}, pkg "${data.path}"`)

      const pkgPath = data.raw !== data.pkg
        ? `${data.pkg}/${data.path}`
        : data.pkg

      // Read the content of the module file of interest
      const fileCode = fs.readFileSync(args.path, 'utf8')

      const contents = `
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
      // https://esbuild.github.io/plugins/#on-load-results
      return {
        contents,
        loader: 'js',
        resolveDir: path.dirname(args.path)
      }
    }

    if (DD_IAST_ENABLED && args.pluginData?.applicationFile) {
      const ext = path.extname(args.path).toLowerCase()
      const isJs = /^\.(js|mjs|cjs)$/.test(ext)
      if (!isJs) return

      if (DEBUG) console.log(`REWRITE: ${args.path}`)
      const fileCode = fs.readFileSync(args.path, 'utf8')
      const rewritten = rewriter.rewrite(fileCode, args.path, ['iast'])
      return {
        contents: rewritten.content,
        loader: 'js',
        resolveDir: path.dirname(args.path)
      }
    }
  })
}

// @see https://github.com/nodejs/node/issues/47000
function dotFriendlyResolve (path, directory) {
  if (path === '.') {
    path = './'
  } else if (path === '..') {
    path = '../'
  }

  return require.resolve(path, { paths: [directory] })
}
