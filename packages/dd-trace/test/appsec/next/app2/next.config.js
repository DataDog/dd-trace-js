/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true
  },
  output: 'standalone'
}

module.exports = nextConfig
