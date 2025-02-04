const path = require('path')

module.exports = {
  entry: './index.js',
  target: 'node',
  mode: 'production',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'dd-trace.bundle.js',
    library: {
      name: 'dd-trace',
      type: 'umd'
    }
  }
}
