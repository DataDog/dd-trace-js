'use strict'

/* eslint-disable object-shorthand */

function isTrue (str) {
  str = String(str).toLowerCase()
  return str === 'true' || str === '1'
}

module.exports = { isTrue: isTrue }
