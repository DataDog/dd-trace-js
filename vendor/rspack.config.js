'use strict'

// TODO: Stop depending on `@opentelemetry/api` and instead intercept the user
//       version with an instrumentation.
// TODO: Fix `import-in-the-middle` so that it doesn't interfere with the global
//       object or switch to our own internal loader and remove the dependency.
// TODO: Vendor `dc-polyfill` and figure out why it fails the tests.

const { CopyRspackPlugin, SwcJsMinimizerRspackPlugin } = require('@rspack/core')
const { LicenseWebpackPlugin } = require('license-webpack-plugin')
const { join } = require('path')
const { dependencies } = require('./package.json')

const include = new Set([
  ...Object.keys(dependencies),
  'mutexify/promise',
  'protobufjs/minimal', // peer dependency for `@datadog/sketches-js`
  'source-map/lib/util' // TODO: remove usage of dependency internals
])

const exclude = new Set([
  'mutexify' // we only ever use `mutexify/promise`
])

const difference = new Set([...include].filter(x => !exclude.has(x)))

// A package can declare a license in `package.json` without publishing a license file: `crypto-randomuuid` ships
// `"license": "MIT"` and no `LICENSE`. The plugin resolves the SPDX id from that field and only lacks the text, so
// fill it from a canonical template keyed by the id rather than per package. The copyright holder for each package is
// recorded separately, in `LICENSE-3rdparty.csv`.
const spdxLicenseTexts = {
  MIT: `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
}

module.exports = {
  entry: Object.fromEntries(difference.entries()),
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
  // This is shared between dd-trace and users, so it needs to be external.
  externals: {
    '@opentelemetry/api': '@opentelemetry/api',
  },
  plugins: [
    new LicenseWebpackPlugin({
      outputFilename: '[name]/LICENSE',
      excludedPackageTest: packageName => !include.has(packageName),
      handleMissingLicenseText: (packageName, licenseType) => {
        const licenseText = spdxLicenseTexts[licenseType]
        if (!licenseText) {
          throw new Error(`'${packageName}' publishes no license text and '${licenseType}' has no known template`)
        }
        return licenseText
      },
      // Every entry bundles code from more than one package, and the module order rspack reports follows the
      // installer's `node_modules` layout, so picking `modules[0]` shipped whichever license happened to come first
      // and omitted the rest. Changing package manager reorders it and a different wrong text ships. Emit every
      // bundled package's license, name-sorted so the output is byte-stable, and fail the build rather than ship a
      // bundle whose license text could not be resolved.
      renderLicenses: modules => modules
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(licenseModule => {
          if (!licenseModule.licenseText) {
            throw new Error(`No license text resolved for bundled package '${licenseModule.name}'`)
          }
          return `${licenseModule.name}\n\n${licenseModule.licenseText.trim()}\n`
        })
        .join(`\n${'-'.repeat(78)}\n\n`),
      stats: {
        warnings: false
      }
    }),
    new CopyRspackPlugin({
      patterns: [
        // Binaries need to be copied manually.
        {
          from: 'source-map/lib/mappings.wasm',
          to: 'source-map'
        },
      ],
    }),
  ],
  output: {
    filename: '[name]/index.js',
    library: {
      type: 'commonjs2'
    },
    path: join(__dirname, 'dist'),
    clean: true
  },
}
