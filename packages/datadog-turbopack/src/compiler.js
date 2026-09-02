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
 * @returns {{ ast: object, traverse: Function }}
 */
function parseSource (source, resourcePath, compiler) {
  const { parse } = require(compiler.parser)
  const traverse = require(compiler.traverse).default
  const plugins = TYPESCRIPT_PATH_PATTERN.test(resourcePath)
    ? TYPESCRIPT_PARSER_PLUGINS
    : JAVASCRIPT_PARSER_PLUGINS

  return {
    ast: parse(source, { plugins, sourceType: 'unambiguous' }),
    traverse,
  }
}

/**
 * @param {{ generator: string }} compiler
 * @returns {Function}
 */
function getGenerator (compiler) {
  return require(compiler.generator).default
}

module.exports = { getGenerator, parseSource }
