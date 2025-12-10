'use strict'

let meriyah
let astring
let esquery

module.exports = {
  parse: (...args) => {
    meriyah ??= require('meriyah')

    return meriyah.parse(...args)
  },

  generate: (...args) => {
    astring ??= require('astring')

    return astring.generate(...args)
  },

  traverse: (ast, query, visitor) => {
    esquery ??= require('esquery')

    const selector = esquery.parse(query)

    return esquery.traverse(ast, selector, visitor)
  },
}
