'use strict'

const path = require('path')
const fs = require('fs')

const INS_PATH = path.join(__dirname, '../datadog-instrumentations/src')

// build list of integrations based on each plugin's addHook calls
// TODO: This has the side effect of subscribing to bundler events. is that OK?
// I think it's ok. This happens at build time. subscribing only matters at run time
for (const entry of fs.readdirSync(INS_PATH)) {
  if (path.extname(entry) !== '.js') continue
  require(path.join(INS_PATH, entry)) // calls addHook()
}

const modulesOfInterest = new Set()

const instrumentations = require('../datadog-instrumentations/src/helpers/instrumentations.js')
for (let foo of Object.values(instrumentations)) {
  for (let group of foo) {
    if (!group.file) {
      modulesOfInterest.add(group.name)
    } else {
      modulesOfInterest.add(`${group.name}/${group.file}`)
    }
  }
}

/* eslint-disable no-console */

const NAMESPACE = 'datadog'

const NM = 'node_modules/'
const NM_LENGTH = NM.length

const instrumented = Object.keys(require('../datadog-instrumentations/src/helpers/hooks.js'))
const rawBuiltins = require('module').builtinModules

warnIfUnsupported()

const builtins = new Set()

for (const builtin of rawBuiltins) {
  builtins.add(builtin)
  builtins.add(`node:${builtin}`)
}

const DEBUG = !!process.env.DD_TRACE_DEBUG

// We don't want to handle any built-in packages via DCITM
// Those packages will still be handled via RITM
// Attempting to instrument them would fail as they have no package.json file
for (const pkg of instrumented) {
  console.log('consider', pkg)
  if (builtins.has(pkg)) continue
  if (pkg.startsWith('node:')) continue
  modulesOfInterest.add(pkg)
}

console.log('MODS', modulesOfInterest)

const DC_CHANNEL = 'dd-trace:bundledModuleLoadStart'

module.exports.name = 'datadog-esbuild'

module.exports.setup = function (build) {
  build.onResolve({ filter: /.*/ }, args => {
    /*
    args = {
      path: './generic-transformers',
      importer: '/Users/thomas.hunter/Projects/client-repro/APMS-9740/node_modules/@redis/client/dist/lib/commands/ZPOPMIN_COUNT.js',
      namespace: 'file',
      resolveDir: '/Users/thomas.hunter/Projects/client-repro/APMS-9740/node_modules/@redis/client/dist/lib/commands',
      kind: 'require-call',
      pluginData: undefined
    }
    */
    const fullPathToModule = dotFriendlyResolve(args.path, args.resolveDir)
    const extracted = extractPackageAndModulePath(fullPathToModule)
    if (extracted.pkg) {
      console.log(extracted.pkg, extracted.path)
    }
    const packageName = args.path

    const internal = builtins.has(args.path)

    if (args.namespace === 'file' && (modulesOfInterest.has(packageName) || modulesOfInterest.has(`${extracted.pkg}/${extracted.path}`))) {
      console.log('MATCH', packageName, `${extracted.pkg} :: ${extracted.path}`)
      // The file namespace is used when requiring files from disk in userland

      let pathToPackageJson
      // TODO: looks like we're trying to find package.json files for deeply nested modules
      try {
        pathToPackageJson = require.resolve(`${extracted.pkg}/package.json`, { paths: [ args.resolveDir ] })
      } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') {
          console.warn(`Unable to open "${extracted.pkg}/package.json". Is the "${extracted.pkg}" package dead code?`)
          return
        } else {
          throw err
        }
      }

      const packageJson = require(pathToPackageJson)

      if (DEBUG) {
        console.log(`resolve ${packageName}@${packageJson.version}`)
      }

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
      // see note in onLoad

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

    if (DEBUG) {
      console.log(`LOAD ${args.path}@${data.version}, pkg "${data.path}"`)
      // console.log(data)
    }

    const channelName = DC_CHANNEL + ':' + (data.raw === data.pkg ? data.raw : data.pkg + ':' + data.path)
    console.log('CHAN', channelName) // TODO getting pkg:index.js instead of pkg
    // TODO: We'll need channels for deep paths too
    // TODO: express just stopped working even though the channel names all appear fine

    // JSON.stringify adds double quotes. For perf gain could simply add in quotes when we know it's safe.
    const contents = `
      const dc = require('diagnostics_channel');
      const ch = dc.channel(${JSON.stringify(channelName)});
      const mod = require(${JSON.stringify(path)});
      const payload = {
        module: mod,
        path: ${JSON.stringify(path)},
        version: ${JSON.stringify(data.version)}
      };
      console.log('emit channel', ${JSON.stringify(channelName)});
      ch.publish(payload);
      payload.module.__datadog = true;
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
