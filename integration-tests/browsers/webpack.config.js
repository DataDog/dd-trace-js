const path = require('path')

module.exports = {
  mode: 'production',
  entry: './bundle-entrypoint.js',
  output: {
    path: path.resolve(__dirname, './out/')
  }
}
