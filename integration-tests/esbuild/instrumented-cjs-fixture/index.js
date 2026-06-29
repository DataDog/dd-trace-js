'use strict'

const relative = require('./relative-module')

module.exports = {
  rel: relative.value,
  filename: __filename,
  dirname: __dirname,
}
