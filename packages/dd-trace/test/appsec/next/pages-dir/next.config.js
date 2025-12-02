const nextPkg = require('next/package.json')
const [majorStr] = nextPkg.version.split('.')
const major = Number(majorStr)

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
}

if (major < 16) {
  nextConfig.eslint = {
    ignoreDuringBuilds: true,
  }
}

module.exports = nextConfig
