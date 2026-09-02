const nextPkg = require('next/package.json')
const [majorStr] = nextPkg.version.split('.')
const major = Number(majorStr)

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    appDir: true,
  },
  output: 'standalone',
}

if (major < 15) {
  nextConfig.experimental.outputFileTracingRoot = __dirname
} else {
  nextConfig.outputFileTracingRoot = __dirname
}

if (major < 16) {
  nextConfig.eslint = {
    ignoreDuringBuilds: true,
  }
}

module.exports = nextConfig
