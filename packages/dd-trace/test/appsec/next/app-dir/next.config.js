/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    appDir: true
  },
  output: 'standalone',
  outputFileTracingRoot: __dirname
}

module.exports = nextConfig
