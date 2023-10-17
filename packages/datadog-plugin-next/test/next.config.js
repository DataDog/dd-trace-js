// Build up the object dynamically to reduce warnings in output

const { satisfies } = require('semver')

const { VERSION } = process.env

const config = {
  eslint: {
    ignoreDuringBuilds: true
  },
  experimental: {}
}

// standalone can be set
if (satisfies(VERSION, '>=12.0.0')) {
  config.output = 'standalone'
}

// appDir needs to be enabled as experimental
if (satisfies(VERSION, '>=13.3.0 <13.4.0')) {
  config.experimental.appDir = true
}

module.exports = config
