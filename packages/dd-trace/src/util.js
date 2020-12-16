'use strict'

function isTrue (str) {
  str = String(str).toLowerCase()
  return str === 'true' || str === '1'
}

function isFalse (str) {
  str = String(str).toLowerCase()
  return str === 'false' || str === '0'
}

function toKeyValuePairs (str) {
  return (str || '').split(',')
    .filter(tag => tag.indexOf(':') !== -1)
    .reduce((prev, next) => {
      const tag = next.split(':')
      const key = tag[0]
      const value = tag.slice(1).join(':')
      prev[key] = value
      return prev
    }, {})
}

module.exports = {
  isTrue,
  isFalse,
  toKeyValuePairs
}
