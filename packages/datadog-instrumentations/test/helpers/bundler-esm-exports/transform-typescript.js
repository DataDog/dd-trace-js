'use strict'

const typescript = require('typescript')

/**
 * @param {string} source
 * @returns {{ code: string }}
 */
module.exports = function transformTypeScript (source) {
  const code = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.ESNext },
  }).outputText
  return { code }
}
