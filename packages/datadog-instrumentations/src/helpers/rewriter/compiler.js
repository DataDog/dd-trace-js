'use strict'

const compiler = module.exports = {
  parse: (filename, sourceText, options) => {
    try {
      const oxc = require('oxc-parser')

      compiler.parse = (sourceText, options) => {
        const { program, errors } = oxc.parseSync('index.js', sourceText, options)

        if (errors?.length > 0) throw errors[0]

        return program
      }
    } catch {
      // Fallback for when OXC is not available.
      const meriyah = require('../../../../../vendor/dist/meriyah')

      compiler.parse = (sourceText, { range, sourceType } = {}) => {
        return meriyah.parse(sourceText.toString(), {
          loc: range,
          ranges: range,
          module: sourceType === 'module',
        })
      }
    }

    return compiler.parse(filename, sourceText, options)
  },

  generate: (...args) => {
    const astring = require('../../../../../vendor/dist/astring')

    compiler.generate = astring.generate

    return compiler.generate(...args)
  },

  traverse: (ast, query, visitor) => {
    const esquery = require('../../../../../vendor/dist/esquery').default

    compiler.traverse = (ast, query, visitor) => {
      return esquery.traverse(ast, esquery.parse(query), visitor)
    }

    return compiler.traverse(ast, query, visitor)
  },

  query: (ast, query) => {
    const esquery = require('../../../../../vendor/dist/esquery').default

    compiler.query = esquery.query

    return compiler.query(ast, query)
  },
}
