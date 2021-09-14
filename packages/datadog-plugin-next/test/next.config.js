module.exports = {
  eslint: {
    ignoreDuringBuilds: true
  },

  webpack: (config) => {
    // TODO figure out why we need to externalize react for next@<11
    if (Number(require('next/package.json').version.split('.')[0]) < 11) {
      const react = require.resolve('react')
      const reactDom = require.resolve('react-dom')
      config.externals = {
        'react': `commonjs2 ${react}`,
        'react-dom': `commonjs2 ${reactDom}`
      }
    }

    return config
  }
}
