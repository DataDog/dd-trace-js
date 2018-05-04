'use strict'

const http = require('./http')

module.exports = {
  name: 'https',
  patch: http.patch,
  unpatch: http.unpatch
}
