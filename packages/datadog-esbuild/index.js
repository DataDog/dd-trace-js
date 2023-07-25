'use strict'

/* eslint-disable no-console */

const path = require('path')
const fs = require('fs')
const instrumentations = require('../datadog-instrumentations/src/helpers/instrumentations.js')

warnIfUnsupported()

{
  // run each instrumentation so that `instrumentations` gets populated
  const INS_PATH = path.join(__dirname, '../datadog-instrumentations/src')

  for (const entry of fs.readdirSync(INS_PATH)) {
    if (path.extname(entry) !== '.js') continue
    require(path.join(INS_PATH, entry))
  }
}

const modulesOfInterest = new Set()

for (let instrumentation of Object.values(instrumentations)) {
  for (let entry of instrumentation) {
    if (!entry.file) {
      modulesOfInterest.add(entry.name) // redis
    } else {
      modulesOfInterest.add(`${entry.name}/${entry.file}`) // redis/my/file.js
    }
  }
}

const NAMESPACE = 'datadog'
const NM = 'node_modules/'
const NM_LENGTH = NM.length
const INSTRUMENTED = Object.keys(require('../datadog-instrumentations/src/helpers/hooks.js'))
const RAW_BUILTINS = require('module').builtinModules

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
  build.onResolve({ filter: /.*/ }, args => {
    const fullPathToModule = dotFriendlyResolve(args.path, args.resolveDir)
    const extracted = extractPackageAndModulePath(fullPathToModule)
    const packageName = args.path

    const internal = builtins.has(args.path)

    if (args.namespace === 'file' && (modulesOfInterest.has(packageName) || modulesOfInterest.has(`${extracted.pkg}/${extracted.path}`))) {
      // The file namespace is used when requiring files from disk in userland

      let pathToPackageJson
      try {
        pathToPackageJson = require.resolve(`${extracted.pkg}/package.json`, { paths: [ args.resolveDir ] })
      } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') {
          if (!internal) console.warn(`Unable to open "${extracted.pkg}/package.json". Is the "${extracted.pkg}" package dead code?`)
          return
        } else {
          throw err
        }
      }

      const packageJson = require(pathToPackageJson)

      if (DEBUG) console.log(`RESOLVE ${packageName}@${packageJson.version}`)

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
    const path = args.path

    if (DEBUG) console.log(`LOAD ${data.pkg}@${data.version}, pkg "${path}"`)

    const contents = `
      const dc = require('diagnostics_channel');
      const ch = dc.channel('dd-trace-esbuild');
      const mod = require('${path}');
      const payload = {
        module: mod,
        path: '${data.raw}',
        version: '${data.version}',
        package: '${data.pkg}',
        relPath: '${data.path}'
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
  const nm = fullPath.lastIndexOf(NM);
  if (nm < 0) {
    return { pkg: null, path: null }
  }

  const subPath = fullPath.substring(nm + NM.length);
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
