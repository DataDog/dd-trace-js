/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true
  },
  experimental: {
    appDir: true
  },
  output: 'standalone',
  outputFileTracingRoot: __dirname
}

module.exports = nextConfig
