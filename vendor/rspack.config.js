'use strict'

// TODO: Stop depending on `@opentelemetry/api` and instead intercept the user
//       version with an instrumentation.
// TODO: Fix `import-in-the-middle` so that its loader doesn't set a flag on the
//       global object, or switch to our own internal loader.
// TODO: Vendor `dc-polyfill` and figure out why it fails the tests.

const { join } = require('node:path')

const { CopyRspackPlugin, DefinePlugin, SwcJsMinimizerRspackPlugin } = require('@rspack/core')
const { LicenseWebpackPlugin } = require('license-webpack-plugin')

const { dependencies } = require('./package.json')

const include = new Set([
  ...Object.keys(dependencies),
  '@datadog/openfeature-node-server/rules-based',
  'mutexify/promise',
  'protobufjs/minimal', // peer dependency for `@datadog/sketches-js`
  'source-map/lib/util', // TODO: remove usage of dependency internals
])

const exclude = new Set([
  'mutexify', // we only ever use `mutexify/promise`
])

const difference = new Set([...include].filter(x => !exclude.has(x)))

// `import-in-the-middle` keeps its package layout: the generated wrapper modules
// import `lib/register.js` relative to the hook URL, and the runtime `index.js`
// must share that same file's hook state, so it is shipped unbundled next to it.
const entry = {
  ...Object.fromEntries(difference.entries()),
  'import-in-the-middle': { import: 'import-in-the-middle', filename: 'import-in-the-middle/index.js' },
  'import-in-the-middle/create-hook': {
    import: 'import-in-the-middle/create-hook.mjs',
    filename: 'import-in-the-middle/create-hook.js',
  },
  'import-in-the-middle/lib/get-exports': {
    import: 'import-in-the-middle/lib/get-exports.mjs',
    filename: 'import-in-the-middle/lib/get-exports.js',
  },
}

const iitmPackagePath = join('node_modules', 'import-in-the-middle')

module.exports = {
  entry,
  externals: [
    // This is shared between dd-trace and users, so it needs to be external.
    { '@opentelemetry/api': '@opentelemetry/api' },
    ({ context, request }, callback) => {
      if (request === './lib/register' && context.includes(iitmPackagePath)) {
        return callback(undefined, 'commonjs ./lib/register.js')
      }
      callback()
    },
  ],
  target: 'node',
  mode: 'production',
  // Using `hidden` removes the URL comment from source files since we don't
  // publish the maps that the comments would be referencing. Since the maps
  // have the same filename as the source files this doesn't matter anyway.
  devtool: 'hidden-source-map',
  context: join(__dirname, 'node_modules'),
  resolve: {
    // Node.js does not use the `module` field, so prefer `main` (CJS) to avoid
    // ESM-only default exports being wrapped in a namespace by rspack's interop,
    // which would break patterns like `require('esquery').parse`.
    mainFields: ['main', 'module'],
  },
  optimization: {
    // Here we used `named` instead of the default of `deterministic` since the
    // default is only deterministic with the same dependencies, but when a
    // dependency is added it would change the IDs of other ones resulting in
    // unnecessary noise.
    checkIds: 'named',
    moduleIds: 'named',
    minimizer: [
      new SwcJsMinimizerRspackPlugin({
        minimizerOptions: {
          mangle: {
            // Similar to the above, we configure the minimizer to keep the
            // original names. In this case it's also useful at runtime when
            // checking the value of the name, or for stack traces when the
            // source maps are not used.
            keepClassNames: true,
            keepFnNames: true,
          },
        },
      }),
    ],
  },
  plugins: [
    // rspack otherwise inlines the build machine's file URL for `import.meta.url`
    // (used by import-in-the-middle's `createRequire`), so resolve it at runtime.
    new DefinePlugin({
      'import.meta.url': 'require("node:url").pathToFileURL(__filename).href',
    }),
    new LicenseWebpackPlugin({
      outputFilename: '[name]/LICENSE',
      excludedPackageTest: packageName => !include.has(packageName),
      renderLicenses: modules => modules[0].licenseText,
      stats: {
        warnings: false,
      },
    }),
    new CopyRspackPlugin({
      patterns: [
        {
          from: '@datadog/openfeature-node-server/rules-based.d.ts',
          to: '@datadog/openfeature-node-server/rules-based/index.d.ts',
        },
        // Binaries need to be copied manually.
        {
          from: 'source-map/lib/mappings.wasm',
          to: 'source-map',
        },
        // Not bundled: it has no dependencies, and its `exports.x =` shape lets
        // cjs-module-lexer expose named exports to the ESM wrappers importing it.
        {
          from: 'import-in-the-middle/lib/register.js',
          to: 'import-in-the-middle/lib/register.js',
        },
      ],
    }),
  ],
  output: {
    filename: '[name]/index.js',
    library: {
      type: 'commonjs2',
    },
    path: join(__dirname, 'dist'),
    clean: true,
  },
}
