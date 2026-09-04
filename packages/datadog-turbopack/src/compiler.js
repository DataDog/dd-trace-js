'use strict'

const BASE_PARSER_PLUGINS = [
  'decorators-legacy',
  'explicitResourceManagement',
  'importAttributes',
  'jsx',
]
const JAVASCRIPT_PARSER_PLUGINS = [...BASE_PARSER_PLUGINS, 'flow']
const TYPESCRIPT_PARSER_PLUGINS = [...BASE_PARSER_PLUGINS, 'typescript']
const TYPESCRIPT_PATH_PATTERN = /\.(?:cts|mts|ts|tsx)$/

/**
 * @param {string} source
 * @param {string} resourcePath
 * @param {{ parser: string, traverse: string }} compiler
 * @param {'commonjs'|'module'|'unambiguous'} [sourceType]
 * @returns {{ ast: object, traverse: Function }}
 */
function parseSource (source, resourcePath, compiler, sourceType = 'unambiguous') {
  const { parse } = require(compiler.parser)
  const traverse = require(compiler.traverse).default
  const plugins = TYPESCRIPT_PATH_PATTERN.test(resourcePath)
    ? TYPESCRIPT_PARSER_PLUGINS
    : JAVASCRIPT_PARSER_PLUGINS
  const parserOptions = sourceType === 'commonjs'
    ? {
        allowNewTargetOutsideFunction: true,
        allowReturnOutsideFunction: true,
        plugins,
        sourceType: 'script',
      }
    : { plugins, sourceType }

  return {
    ast: parse(source, parserOptions),
    traverse,
  }
}

module.exports = { parseSource }
