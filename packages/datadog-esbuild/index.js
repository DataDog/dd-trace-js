const NAMESPACE = 'datadog'

const instrumented = Object.keys(require('../datadog-instrumentations/src/helpers/hooks.js'))
const rawBuiltins = require('module').builtinModules

const builtins = new Set()

for (const builtin of rawBuiltins) {
  builtins.add(builtin)
  builtins.add(`node:${builtin}`)
}

const packagesOfInterest = new Set()

const DEBUG = !!process.env.DD_TRACE_DEBUG

// We don't want to handle any built-in packages via DCITM
// Those packages will still be handled via RITM
// Attempting to instrument them would fail as they have no package.json file
for (const pkg of instrumented) {
  if (builtins.has(pkg)) continue
  if (pkg.startsWith('node:')) continue
  packagesOfInterest.add(pkg)
}

const DC_CHANNEL = 'dd-trace:bundledModuleLoadStart'

module.exports.name = 'datadog-esbuild'

module.exports.setup = function (build) {
  build.onResolve({ filter: /.*/ }, args => {
    const packageName = args.path

    if (args.namespace === 'file' && packagesOfInterest.has(packageName)) {
      // The file namespace is used when requiring files from disk in userland
      const pathToPackageJson = require.resolve(`${packageName}/package.json`, { paths: [ args.resolveDir ] })
      const pkg = require(pathToPackageJson)

      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.log(`resolve ${packageName}@${pkg.version}`)
      }

      // https://esbuild.github.io/plugins/#on-resolve-arguments
      return {
        path: packageName,
        namespace: NAMESPACE,
        pluginData: {
          version: pkg.version
        }
      }
    } else if (args.namespace === 'datadog') {
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
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`load ${args.path}@${args.pluginData.version}`)
    }

    // JSON.stringify adds double quotes. For perf gain could simply add in quotes when we know it's safe.
    const contents = `
      const dc = require('diagnostics_channel');
      const ch = dc.channel(${JSON.stringify(DC_CHANNEL + ':' + args.path)});
      const mod = require(${JSON.stringify(args.path)});
      const payload = {
        module: mod,
        path: ${JSON.stringify(args.path)},
        version: ${JSON.stringify(args.pluginData.version)}
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
