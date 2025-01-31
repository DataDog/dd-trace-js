const path = require('path')

module.exports = {
  entry: './init.js',
  target: 'node',
  mode: 'production',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'dd-trace.bundle.js'
  }
}
