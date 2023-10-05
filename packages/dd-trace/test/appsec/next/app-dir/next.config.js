/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true
  },
  experimental: {
    appDir: true
  },
  output: 'standalone'
}

module.exports = nextConfig
