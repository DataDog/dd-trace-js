'use strict'

let meriyah
let astring
let esquery

module.exports = {
  parse: (...args) => {
    meriyah ??= require('../../../../../vendor/dist/meriyah')

    return meriyah.parse(...args)
  },

  generate: (...args) => {
    astring ??= require('../../../../../vendor/dist/astring')

    return astring.generate(...args)
  },

  traverse: (ast, query, visitor) => {
    esquery ??= require('../../../../../vendor/dist/esquery').default

    const selector = esquery.parse(query)

    return esquery.traverse(ast, selector, visitor)
  },
}
