'use strict'

/* eslint-disable no-console */

const instrumentations = require('../datadog-instrumentations/src/helpers/instrumentations.js')
const hooks = require('../datadog-instrumentations/src/helpers/hooks.js')
const extractPackageAndModulePath = require(
  '../datadog-instrumentations/src/helpers/extract-package-and-module-path.js'
)

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

module.exports.setup = function (build) {
  const externalModules = new Set(build.initialOptions.external || [])
  if (isESMBuild(build)) {
    build.initialOptions.banner ??= {}
    build.initialOptions.banner.js ??= ''
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
