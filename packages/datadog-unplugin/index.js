'use strict'

const fs = require('node:fs')
const path = require('node:path')
const RAW_BUILTINS = require('node:module').builtinModules

const { createUnplugin } = require('unplugin')

const instrumentations = require('../datadog-instrumentations/src/helpers/instrumentations')
const extractPackageAndModulePath = require('../datadog-instrumentations/src/helpers/extract-package-and-module-path')
const hooks = require('../datadog-instrumentations/src/helpers/hooks')

// Populate instrumentations by calling all hook functions (same as esbuild plugin does at module load time)
for (const hook of Object.values(hooks)) {
  if (hook !== null && typeof hook === 'object') {
    hook.fn()
  } else {
    hook()
  }
}

// Build set of modules of interest from populated instrumentations
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

// Build set of Node.js built-in modules
const builtins = new Set()

for (const builtin of RAW_BUILTINS) {
  builtins.add(builtin)
  builtins.add(`node:${builtin}`)
}

const CHANNEL = 'dd-trace:bundler:load'
const VIRTUAL_MODULE_PREFIX = '\0dd-trace-instrument:'

// Resolve dc-polyfill and bundler-register at plugin load time so the generated code can use
// absolute paths, avoiding resolution context issues with virtual modules.
const dcPolyfillPath = require.resolve('dc-polyfill')

// bundler-register.js subscribes to dd-trace:bundler:load. We require it first in every
// virtual wrapper to guarantee the subscriber is set up before ch.publish() fires, regardless
// of the order in which modules are loaded inside the bundle.
const bundlerRegisterPath = require.resolve('../datadog-instrumentations/src/helpers/bundler-register')

module.exports = createUnplugin(() => {
  return {
    name: 'datadog',

    /**
     * ESBuild escape hatch: disable unplugin's generated onResolve/onLoad handlers
     * (by using filters that never match) and delegate entirely to the existing
     * ESBuild plugin via esbuild.setup. This avoids conflicts between the generic
     * virtual-module resolveId/load hooks and the ESBuild-specific plugin logic.
     */
    esbuild: {
      onResolveFilter: /^$/, // never matches — disables unplugin's onResolve wrapper
      onLoadFilter: /^$/, // never matches — disables unplugin's onLoad wrapper
      setup (build) {
        require('../datadog-esbuild/index.js').setup(build)
      },
    },

    /**
     * Webpack-specific hook for intercepting Node.js built-in module requests.
     *
     * Problem: webpack's NodeTargetPlugin marks built-ins (http, https, etc.) as externals
     * in NMF.hooks.factorize, BEFORE the resolver runs. This means our resolveId hook is
     * never called for bare built-in specifiers in webpack. To instrument them, we must
     * intercept at NMF.hooks.beforeResolve, which fires BEFORE the externals check.
     *
     * Approach: redirect built-in requests to a virtual wrapper file. The wrapper requires
     * the original built-in (which webpack then externalizes normally) and publishes to the
     * dd-trace:bundler:load channel so the tracer can instrument it.
     *
     * @param {object} compiler - the webpack compiler instance
     */
    webpack (compiler) {
      const VirtualModulesPlugin = require('webpack-virtual-modules')

      // Build virtual wrapper files for each built-in in modulesOfInterest
      const virtualFiles = Object.create(null) // virtualPath -> fileContent
      const redirects = new Map() // 'http' and 'node:http' -> virtualPath

      const context = compiler.context || process.cwd()

      for (const mod of modulesOfInterest) {
        if (!builtins.has(mod)) continue

        const virtualPath = path.resolve(context, `_dd_builtin_${mod}.js`)
        virtualFiles[virtualPath] = [
          "'use strict'",
          `require(${JSON.stringify(bundlerRegisterPath)});`,
          `const _original = require(${JSON.stringify(mod)});`,
          `const dc = require(${JSON.stringify(dcPolyfillPath)});`,
          `const ch = dc.channel(${JSON.stringify(CHANNEL)});`,
          'const payload = {',
          '  module: _original,',
          '  version: null,',
          `  package: ${JSON.stringify(mod)},`,
          `  path: ${JSON.stringify(mod)}`,
          '};',
          'ch.publish(payload);',
          'module.exports = payload.module;',
        ].join('\n')

        redirects.set(mod, virtualPath)
        redirects.set(`node:${mod}`, virtualPath)
      }

      if (redirects.size === 0) return

      new VirtualModulesPlugin(virtualFiles).apply(compiler)

      compiler.hooks.normalModuleFactory.tap('DatadogBuiltins', (nmf) => {
        nmf.hooks.beforeResolve.tap('DatadogBuiltins', (resolveData) => {
          const virtualPath = redirects.get(resolveData.request)
          if (!virtualPath) return

          // Recursion guard: when the virtual wrapper itself requires the original
          // built-in (e.g. require('http')), let webpack externalize it normally.
          if (resolveData.contextInfo.issuer === virtualPath) return

          resolveData.request = virtualPath
          resolveData.context = path.dirname(virtualPath)

          // webpack's ExternalsPlugin (NodeTargetPlugin) checks dependency.request,
          // not resolveData.request. We must update all dependencies so ExternalsPlugin
          // does not match the original built-in name and create an ExternalModule.
          for (const dep of resolveData.dependencies) {
            if (dep.request !== undefined) dep.request = virtualPath
          }
        })
      })
    },

    /**
     * @param {string} id - the module specifier being imported (e.g. 'express')
     * @param {string | undefined} importer - the absolute path of the importing file
     * @returns {string | null} virtual module ID or null to defer to default resolution
     */
    resolveId (id, importer) {
      // Skip absolute paths and already-virtual modules
      if (path.isAbsolute(id) || id.startsWith('\0')) return null

      // Skip if the importer is one of our own virtual modules.
      // This prevents infinite recursion: the virtual module for e.g. 'http' does
      // require('http'), which would trigger resolveId again. Returning null here lets
      // webpack resolve it normally (as a Node.js external for target:node builds).
      if (importer && importer.startsWith(VIRTUAL_MODULE_PREFIX)) return null

      // For relative paths (e.g. './lib/express' within express/index.js), only process
      // them when the importer is itself inside node_modules — i.e. it's an intra-package
      // require that may resolve to a file we instrument. Application code relative
      // imports are always skipped so we don't disturb normal app file resolution.
      if (id.startsWith('.') && (!importer || !importer.includes('node_modules/'))) return null
      // Fall through to resolve and check against modulesOfInterest

      // Handle Node.js built-in modules that are in modulesOfInterest (e.g. 'http', 'https').
      // Webpack's __webpack_require__ cache prevents RITM from reliably intercepting built-ins,
      // so we create virtual modules for them and instrument via the bundler:load channel instead.
      if (builtins.has(id)) {
        // Normalize 'node:http' → 'http' for modulesOfInterest lookup
        const normalizedId = id.startsWith('node:') ? id.slice(5) : id
        if (!modulesOfInterest.has(normalizedId) && !modulesOfInterest.has(id)) return null

        return VIRTUAL_MODULE_PREFIX + JSON.stringify({
          pkg: normalizedId,
          version: null,
          pkgPath: normalizedId,
          full: null, // null signals built-in: require by specifier, not by absolute path
          raw: id,
        })
      }

      // Resolve the module to an absolute path so we can inspect it
      let fullPath
      try {
        const resolveOptions = importer ? { paths: [path.dirname(importer)] } : {}
        fullPath = require.resolve(id, resolveOptions)
      } catch {
        return null
      }

      const extracted = extractPackageAndModulePath(fullPath)
      if (!extracted.pkg) return null

      // Check if this module (by original specifier or resolved pkg/path) is of interest
      if (!modulesOfInterest.has(id) && !modulesOfInterest.has(`${extracted.pkg}/${extracted.path}`)) {
        return null
      }

      // Read package.json for the version
      let version
      try {
        const pkgJson = JSON.parse(fs.readFileSync(extracted.pkgJson, 'utf8'))
        version = pkgJson.version
      } catch {
        return null
      }

      // Match the esbuild plugin's pkgPath convention: bare name if it's the package root,
      // otherwise pkg + resolved subpath
      const pkgPath = id === extracted.pkg ? id : `${extracted.pkg}/${extracted.path}`

      return VIRTUAL_MODULE_PREFIX + JSON.stringify({
        pkg: extracted.pkg,
        version,
        pkgPath,
        full: fullPath,
        raw: id,
      })
    },

    /**
     * Restrict the load hook (and its webpack loader) to only our virtual modules.
     * Without this, unplugin applies its load loader to ALL files with type "javascript/auto",
     * which breaks webpack's JSON and other non-JS file handling.
     *
     * @param {string} id - module ID
     * @returns {boolean} true if the load hook should process this module
     */
    loadInclude (id) {
      return id.startsWith(VIRTUAL_MODULE_PREFIX)
    },

    /**
     * @param {string} id - module ID, may be a virtual module ID from resolveId
     * @returns {string | null} CJS module source or null for non-virtual modules
     */
    load (id) {
      if (!id.startsWith(VIRTUAL_MODULE_PREFIX)) return null

      const data = JSON.parse(id.slice(VIRTUAL_MODULE_PREFIX.length))

      // For built-ins (full === null), require by the original specifier (e.g. 'http').
      // Webpack resolves this as a Node.js external for target:node builds.
      // For npm packages, require by absolute path to avoid resolution context issues.
      const originalRequire = data.full === null
        ? JSON.stringify(data.raw)
        : JSON.stringify(data.full)

      return `
require(${JSON.stringify(bundlerRegisterPath)});
const _original = require(${originalRequire});
const dc = require(${JSON.stringify(dcPolyfillPath)});
const ch = dc.channel(${JSON.stringify(CHANNEL)});
const payload = {
  module: _original,
  version: ${JSON.stringify(data.version)},
  package: ${JSON.stringify(data.pkg)},
  path: ${JSON.stringify(data.pkgPath)}
};
ch.publish(payload);
module.exports = payload.module;
`
    },
  }
})
