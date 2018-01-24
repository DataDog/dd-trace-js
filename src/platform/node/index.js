'use strict'

var http = require('http')
var assign = require('lodash.assign')

module.exports = {
  request: function (options, callback) {
    options = assign({
      headers: {},
      timeout: 5000
    }, options)

    options.headers['Content-Length'] = byteLength(options.data)

    var req = http.request(options, function (res) {
      res.on('data', function (chunk) {})

      res.on('end', function () {
        if (res.statusCode >= 200 && res.statusCode <= 299) {
          callback(null)
        } else {
          var error = new Error(http.STATUS_CODES[res.statusCode])
          error.status = res.statusCode

          callback(error)
        }
      })
    })

    req.setTimeout(options.timeout, function () {
      req.abort()
    })

    req.on('error', function (e) {
      callback(e)
    })

    req.write(options.data)
    req.end()
  }
}

function byteLength (data) {
  return data ? data.length : 0
}
