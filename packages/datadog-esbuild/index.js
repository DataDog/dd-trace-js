'use strict'

/* eslint-disable no-console */

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

const NM = 'node_modules/'
const INSTRUMENTED = Object.keys(instrumentations)
const RAW_BUILTINS = require('module').builtinModules
const CHANNEL = 'dd-trace:bundler:load'
const path = require('path')
const fs = require('fs')

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
      // Internal Node.js packages will still be instrumented via require()
      if (DEBUG) console.log(`EXTERNAL: ${args.path}`)
      return
    }

    // TODO: Should this also check for namespace === 'file'?
    if (args.path.startsWith('.') && !args.importer.includes('node_modules/')) {
      // This is local application code, not an instrumented package
      if (DEBUG) console.log(`LOCAL: ${args.path}`)
      return
    }

    // TODO: Should this also check for namespace === 'file'?
    if (args.path.startsWith('@') && !args.importer.includes('node_modules/')) {
      // This is the Next.js convention for loading local files
      if (DEBUG) console.log(`@LOCAL: ${args.path}`)
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

    const internal = builtins.has(args.path)

    if (args.namespace === 'file' && (
      modulesOfInterest.has(args.path) || modulesOfInterest.has(`${extracted.pkg}/${extracted.path}`))
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
    if (!args.pluginData?.pkgOfInterest) {
      return
    }

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
        const dc = require('diagnostics_channel');
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
