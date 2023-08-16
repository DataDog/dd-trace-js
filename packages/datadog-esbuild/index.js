'use strict'

/* eslint-disable no-console */

const path = require('path')
const instrumentations = require('../datadog-instrumentations/src/helpers/instrumentations.js')
const hooks = require('../datadog-instrumentations/src/helpers/hooks.js')

warnIfUnsupported()

for (const hook of Object.values(hooks)) {
  hook()
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

const NAMESPACE = 'datadog'
const NM = 'node_modules/'
const INSTRUMENTED = Object.keys(instrumentations)
const RAW_BUILTINS = require('module').builtinModules
const CHANNEL = 'dd-trace:bundler:load'

const builtins = new Set()

for (const builtin of RAW_BUILTINS) {
  builtins.add(builtin)
  builtins.add(`node:${builtin}`)
}

const DEBUG = !!process.env.DD_TRACE_DEBUG

// We don't want to handle any built-in packages
// Those packages will still be handled via RITM
// Attempting to instrument them would fail as they have no package.json file
for (const pkg of INSTRUMENTED) {
  if (builtins.has(pkg)) continue
  if (pkg.startsWith('node:')) continue
  modulesOfInterest.add(pkg)
}

module.exports.name = 'datadog-esbuild'

module.exports.setup = function (build) {
  const externalModules = new Set(build.initialOptions.external || [])
  build.onResolve({ filter: /.*/ }, args => {
    if (externalModules.has(args.path)) {
      if (DEBUG) console.log(`EXTERNAL: ${args.path}`)
      return
    }

    const isTypeScript = ['ts', 'tsx'].includes(path.extname(args.importer))

    let fullPathToModule
    try {
      fullPathToModule = agnosticResolver(args.path, args.resolveDir, isTypeScript)
    } catch (err) {
      console.warn(`MISSING: Unable to find "${args.path}". Is the package dead code?`)
      return
    }
    const extracted = extractPackageAndModulePath(fullPathToModule)
    const packageName = args.path

    const internal = builtins.has(args.path)

    if (args.namespace === 'file' && (
      modulesOfInterest.has(packageName) || modulesOfInterest.has(`${extracted.pkg}/${extracted.path}`))
    ) {
      // The file namespace is used when requiring files from disk in userland

      let pathToPackageJson
      try {
        pathToPackageJson = require.resolve(`${extracted.pkg}/package.json`, { paths: [ args.resolveDir ] })
      } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') {
          if (!internal) {
            console.warn(`MISSING: Unable to find "${extracted.pkg}/package.json". Is the package dead code?`)
          }
          return
        } else {
          throw err
        }
      }

      const packageJson = require(pathToPackageJson)

      if (DEBUG) console.log(`RESOLVE: ${packageName}@${packageJson.version}`)

      // https://esbuild.github.io/plugins/#on-resolve-arguments
      return {
        path: fullPathToModule,
        namespace: NAMESPACE,
        pluginData: {
          version: packageJson.version,
          pkg: extracted.pkg,
          path: extracted.path,
          full: fullPathToModule,
          raw: packageName,
          internal
        }
      }
    } else if (args.namespace === NAMESPACE) {
      // The datadog namespace is used when requiring files that are injected during the onLoad stage

      if (builtins.has(packageName)) return

      return {
        path: require.resolve(packageName, { paths: [ args.resolveDir ] }),
        namespace: 'file'
      }
    }
  })

  build.onLoad({ filter: /.*/, namespace: NAMESPACE }, args => {
    const data = args.pluginData

    if (DEBUG) console.log(`LOAD: ${data.pkg}@${data.version}, pkg "${data.path}"`)

    const path = data.raw !== data.pkg
      ? `${data.pkg}/${data.path}`
      : data.pkg

    const contents = `
      const dc = require('diagnostics_channel');
      const ch = dc.channel('${CHANNEL}');
      const mod = require('${args.path}');
      const payload = {
        module: mod,
        version: '${data.version}',
        package: '${data.pkg}',
        path: '${path}'
      };
      ch.publish(payload);
      module.exports = payload.module;
    `

    // https://esbuild.github.io/plugins/#on-load-results
    return {
      contents,
      loader: 'js'
    }
  })
}

// Currently esbuild support requires Node.js >=v16.17 or >=v18.7
// Better yet it would support Node >=v14.17 or >=v16
// Of course, the most ideal would be to support all versions of Node that dd-trace supports.
// Version constraints based on Node's diagnostics_channel support
function warnIfUnsupported () {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (
    major < 16 ||
    (major === 16 && minor < 17) ||
    (major === 18 && minor < 7)) {
    console.error('WARNING: Esbuild support isn\'t available for older versions of Node.js.')
    console.error(`Expected: Node.js >=v16.17 or >=v18.7. Actual: Node.js = ${process.version}.`)
    console.error('This application may build properly with this version of Node.js, but unless a')
    console.error('more recent version is used at runtime, third party packages won\'t be instrumented.')
  }
}

// This is basically a replacement for require.resolve()
// However it will find files regardless of if they're .ts or .js files
function agnosticResolver (loaderPath, directory, isTypeScript = false) {
  // @see https://github.com/nodejs/node/issues/47000
  if (loaderPath === '.') {
    loaderPath = './'
  } else if (loaderPath === '..') {
    loaderPath = '../'
  }

  try {
    return require.resolve(loaderPath, { paths: [ directory ] })
  } catch (err) {
    if (isTypeScript) {
      // If we've been unable to resolve a path to the file on disk,
      // and it turns out we're a TypeScript document,
      // then make a few attempts to look for a .ts file to open.

      if (DEBUG) console.log(`TS RESOLVE: ${directory} : ${loaderPath}`)

      try {
        // /foo/bar/bam.ts import('./bif') => /foo/bar/bif.ts
        return agnosticResolver(loaderPath + '.ts', directory)
      } catch (_err) {
        // /foo/bar/bam.ts import('./bif') => /foo/bar/bif/index.ts
        try {
          return agnosticResolver('index.ts', path.join(directory, loaderPath))
        } catch (_err) {
          // At this point we're not sure what could be happening.
          // But, the previous two recursive agnosticResolver() errors are useless.
          // Only the original error matters.
          throw err
        }
      }
    }

    throw err
  }
}

/**
 * For a given full path to a module,
 *   return the package name it belongs to and the local path to the module
 *   input: '/foo/node_modules/@co/stuff/foo/bar/baz.js'
 *   output: { pkg: '@co/stuff', path: 'foo/bar/baz.js' }
 */
function extractPackageAndModulePath (fullPath) {
  const nm = fullPath.lastIndexOf(NM)
  if (nm < 0) {
    return { pkg: null, path: null }
  }

  const subPath = fullPath.substring(nm + NM.length)
  const firstSlash = subPath.indexOf('/')

  if (subPath[0] === '@') {
    const secondSlash = subPath.substring(firstSlash + 1).indexOf('/')

    return {
      pkg: subPath.substring(0, firstSlash + 1 + secondSlash),
      path: subPath.substring(firstSlash + 1 + secondSlash + 1)
    }
  }

  return {
    pkg: subPath.substring(0, firstSlash),
    path: subPath.substring(firstSlash + 1)
  }
}

