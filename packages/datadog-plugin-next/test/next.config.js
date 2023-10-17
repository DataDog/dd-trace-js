module.exports = {
  eslint: {
    ignoreDuringBuilds: true
  },
  // this will warn when server is run normally, but it won't have any other effect
  output: 'standalone',
  experimental: {
    appDir: true // likewise here, will just warn if appDir is not experimental but not change anything
  }
}
