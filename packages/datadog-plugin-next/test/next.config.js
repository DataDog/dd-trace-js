// Build config dynamically for ease in testing and modification

const { satisfies } = require('semver')

const { VERSION } = process.env // Next.js version to dynamically modify parts

const config = {
  eslint: {
    ignoreDuringBuilds: true
  },
  experimental: {}
}

// Ensure webpack 5 is used by default for older versions
if (satisfies(VERSION, '<11')) {
  config.future = {
    webpack5: true
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
      'util/types': false
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
