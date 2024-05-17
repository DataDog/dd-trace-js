'use strict'

/* eslint-disable no-console */

const instrumentations = require('../datadog-instrumentations/src/helpers/instrumentations.js')
const hooks = require('../datadog-instrumentations/src/helpers/hooks.js')
const extractPackageAndModulePath = require('../datadog-instrumentations/src/utils/src/extract-package-and-module-path')

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
      if (DEBUG) {
        console.warn(`Warning: Unable to find "${args.path}".` +
          "Unless it's dead code this could cause a problem at runtime.")
      }
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
        pathToPackageJson = require.resolve(`${extracted.pkg}/package.json`, { paths: [args.resolveDir] })
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
