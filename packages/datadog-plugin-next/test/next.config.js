const path = require('path')

module.exports = {
  webpack: (config) => {
    const react = path.resolve(__dirname, '../../../versions/node_modules/react')
    const reactDom = path.resolve(__dirname, '../../../versions/node_modules/react-dom')

    config.externals = {
      'react': `commonjs2 ${react}`,
      'react-dom': `commonjs2 ${reactDom}`
    }

    return config
  }
}
