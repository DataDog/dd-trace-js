'use strict'

// eslint-disable-next-line camelcase, no-undef
const runtimeRequire = typeof __webpack_require__ === 'function' ? __non_webpack_require__ : require

const compiler = module.exports = {
  parse: (sourceText, options) => {
    try {
      // TODO: Figure out ESBuild `createRequire` issue and remove this hack.
      const oxc = runtimeRequire(['oxc', 'parser'].join('-'))

      compiler.parse = (sourceText, options) => {
        const { program, errors } = oxc.parseSync('index.js', sourceText, {
          ...options,
          preserveParens: false,
        })

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

    return compiler.parse(sourceText, options)
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
