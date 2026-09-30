'use strict'

// TODO: Stop depending on `@opentelemetry/api` and instead intercept the user
//       version with an instrumentation.
// TODO: Fix `import-in-the-middle` so that it doesn't interfere with the global
//       object or switch to our own internal loader and remove the dependency.
// TODO: Vendor `dc-polyfill` and figure out why it fails the tests.

const { join } = require('node:path')

const { CopyRspackPlugin, SwcJsMinimizerRspackPlugin } = require('@rspack/core')
const { LicenseWebpackPlugin } = require('license-webpack-plugin')

const { dependencies } = require('./package.json')

const include = new Set([
  ...Object.keys(dependencies),
  'mutexify/promise',
  'protobufjs/minimal', // peer dependency for `@datadog/sketches-js`
  'source-map/lib/util', // TODO: remove usage of dependency internals
])

const exclude = new Set([
  '@jsquash/webp', // only the basic encoder is used by webdriverio-video
  'mediabunny', // only WebM output is used by webdriverio-video
  'mutexify', // we only ever use `mutexify/promise`
  'pngjs', // only synchronous decoding is used by webdriverio-video
])

const difference = new Set([...include].filter(x => !exclude.has(x)))

module.exports = {
  entry: {
    ...Object.fromEntries(difference.entries()),
    'webdriverio-video': join(__dirname, 'webdriverio-video.mjs'),
  },
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
  module: {
    rules: [{
      test: /webp_enc\.js$/,
      // The worker provides the bytes explicitly; no browser URL or extra asset is needed.
      parser: { url: false },
    }],
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
  // This is shared between dd-trace and users, so it needs to be external.
  externals: {
    '@opentelemetry/api': '@opentelemetry/api',
  },
  plugins: [
    new LicenseWebpackPlugin({
      outputFilename: '[name]/LICENSE',
      excludedPackageTest: packageName => !include.has(packageName),
      additionalChunkModules: {
        'webdriverio-video': ['@jsquash/webp', 'mediabunny'].map(name => ({
          name,
          directory: join(__dirname, 'node_modules', name),
        })),
      },
      renderLicenses: modules => modules.some(module => module.name === '@jsquash/webp')
        ? modules.map(module => `${module.name}\n${module.licenseText}`).join('\n\n')
        : modules[0].licenseText,
      stats: {
        warnings: false,
      },
    }),
    new CopyRspackPlugin({
      patterns: [
        // Binaries need to be copied manually.
        {
          from: 'source-map/lib/mappings.wasm',
          to: 'source-map',
        },
        {
          from: '@jsquash/webp/codec/enc/webp_enc.wasm',
          to: 'webdriverio-video',
        },
        {
          from: '@jsquash/webp/codec/LICENSE.codec.md',
          to: 'webdriverio-video/libwebp/LICENSE',
          toType: 'file',
        },
        {
          from: join(__dirname, 'webdriverio-video.d.ts'),
          to: 'webdriverio-video/index.d.ts',
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
