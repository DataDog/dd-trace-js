'use strict'

function insecureWithResCookieMethod (key, value, res) {
  res.cookie(key, value)
}

function insecureWithResHeaderMethod (key, value, res) {
  res.header('set-cookie', `${key}=${value}`)
}

function insecureWithResHeaderMethodWithArray (key, value, key2, value2, res) {
  res.header('set-cookie', [`${key}=${value}`, `${key2}=${value2}`])
}

module.exports = {
  insecureWithResCookieMethod,
  insecureWithResHeaderMethod,
  insecureWithResHeaderMethodWithArray
}
