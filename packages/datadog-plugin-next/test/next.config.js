'use strict'

// Build config dynamically for ease in testing and modification

const { satisfies } = require('semver')

const { VERSION } = process.env // Next.js version to dynamically modify parts

// `VERSION` is a range (e.g. `>=13.3.0`) when the server is started by the test harness, so the
// next-16 checks below read the resolved version off the installed package instead.
const nextMajor = Number(require('next/package.json').version.split('.')[0])

const config = {
  experimental: {},
}

// The `eslint` config key was removed in Next.js 16; it triggers an "Unrecognized
// key" error there. Keep it only for the versions that still understand it.
if (nextMajor < 16) {
  config.eslint = {
    ignoreDuringBuilds: true,
  }
}

// Next.js 16 builds with Turbopack, which infers the workspace root from the
// nearest lockfile and walks up past the monorepo when one sits higher in the
// tree. Pin the root to this app so tracing stays scoped to it.
if (nextMajor >= 16) {
  config.turbopack = {
    root: __dirname,
  }
}

// App-router route handlers are bundled by default; the bundler cannot process
// dd-trace's dynamic requires and native bindings. Keep it external so the bare
// `require('dd-trace')` resolves to the process tracer at runtime, the same way a
// customer configures it. Pages API routes are externalized without this.
if (nextMajor >= 15) {
  config.serverExternalPackages = ['dd-trace']
} else if (nextMajor >= 13) {
  config.experimental.serverComponentsExternalPackages = ['dd-trace']
}

// Ensure webpack 5 is used by default for older versions
if (satisfies(VERSION, '<11')) {
  config.future = {
    webpack5: true,
  }
}

// In older versions of Next.js (11.X and before), the webpack config doesn't support 'node' prefixes by default
// So, any "node" prefixes are replaced for these older versions by this webpack plugin
// Additionally, webpack was having problems with our use of 'worker_threads', so we don't resolve it
if (satisfies(VERSION, '<=11')) {
  config.webpack = (config, { webpack }) => {
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^node:/, resource => {
        resource.request = resource.request.replace(/^node:/, '')
      })
    )

    config.resolve.preferRelative = true

    // for future errors, any node:* module that produces a webpack build error should be added here
    config.resolve.fallback = {
      ...config.resolve.fallback,
      worker_threads: false,
      perf_hooks: false,
      'util/types': false,
    }

    return config
  }
}

// standalone only enabled in versions it is present
if (satisfies(VERSION, '>=12.0.0')) {
  config.output = 'standalone'
}

// appDir needs to be enabled as experimental
if (satisfies(VERSION, '>=13.3.0 <13.4.0')) {
  config.experimental.appDir = true
}

module.exports = config
