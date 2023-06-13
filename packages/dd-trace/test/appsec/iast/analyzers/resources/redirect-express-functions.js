'use strict'

function insecureWithResHeaderMethod (headerName, value, res) {
  res.header(headerName, value)
}

function insecureWithResRedirectMethod (value, res) {
  res.redirect(200, value)
}

function insecureWithResLocationMethod (value, res) {
  res.location(value)
}

module.exports = {
  insecureWithResHeaderMethod,
  insecureWithResRedirectMethod,
  insecureWithResLocationMethod
}
