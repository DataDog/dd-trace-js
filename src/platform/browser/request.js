'use strict'

const http = require('http')

function request (options, callback) {
  options = Object.assign({
    headers: {}
  }, options)

  options.headers['Content-Type'] = 'application/json'

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const url = `${options.protocol}//${options.hostname}:${options.port}${options.path}`

    xhr.onload = function() {
      if (this.status >= 200 && this.status <= 299) {
        resolve()
      }
    }
    xhr.onerror = () => reject(new TypeError('network request failed'))
    xhr.ontimeout = () => reject(new TypeError('network request timed out'))

    xhr.open(options.method, url, true)

    Object.entries(options.headers).forEach(([k, v]) => {
      xhr.setRequestHeader(k, v)
    })

    xhr.send(options.data)
  })
}

module.exports = request
