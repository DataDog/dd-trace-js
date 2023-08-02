'use strict'

/* eslint-disable no-console */

const instrumentations = require('../datadog-instrumentations/src/helpers/instrumentations.js')
const hooks = require('../datadog-instrumentations/src/helpers/hooks.js')

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

    let fullPathToModule
    try {
      fullPathToModule = dotFriendlyResolve(args.path, args.resolveDir)
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
      const dc = require('dd-trace/diagnostics_channel');
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

// @see https://github.com/nodejs/node/issues/47000
function dotFriendlyResolve (path, directory) {
  if (path === '.') {
    path = './'
  } else if (path === '..') {
    path = '../'
  }

  return require.resolve(path, { paths: [ directory ] })
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
