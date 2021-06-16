const path = require('path')

module.exports = {
  eslint: {
    ignoreDuringBuilds: true
  },

  webpack5: false,

  future: {
    // legacy option
    webpack5: false
  },

  webpack: (config) => {
    const react = path.resolve(__dirname, '../../../versions/node_modules/react')
    const reactDom = path.resolve(__dirname, '../../../versions/node_modules/react-dom')

    config.externals = {
      'react': `commonjs2 ${react}`,
      'react-dom': `commonjs2 ${reactDom}`
    }

    // TODO: drop support for Next <10.1, enable webpack5 above, and uncomment:
    // config.module.rules.push({
    //   test: /\/dd-trace\/src\/native\/.+$/,
    //   type: 'asset/source'
    // })

    return config
  }
}
