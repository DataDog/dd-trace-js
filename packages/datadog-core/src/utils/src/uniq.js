'use strict'

module.exports = function uniq (arr) {
  return [...new Set(arr)]
}
