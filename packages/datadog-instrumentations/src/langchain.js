'use strict'
const { addHook } = require('./helpers/instrument')

// langchain compiles into ESM and CommonJS, with ESM being the default and landing in the `.js` files
// however, CommonJS ends up in `cjs` files, and are required under the hood with `.cjs` files
// we patch each separately and explicitly to match against exports only once, and not rely on file regex matching
const extensions = ['js', 'cjs']

for (const extension of extensions) {
  addHook({ name: '@langchain/core', file: `dist/runnables/base.${extension}`, versions: ['>=0.1'] }, exports => {
    return exports
  })

  addHook({
    name: '@langchain/core',
    file: `dist/language_models/chat_models.${extension}`,
    versions: ['>=0.1']
  }, exports => {
    return exports
  })

  addHook({ name: '@langchain/core', file: `dist/language_models/llms.${extension}`, versions: ['>=0.1'] }, exports => {
    return exports
  })

  addHook({ name: '@langchain/core', file: `dist/embeddings.${extension}`, versions: ['>=0.1'] }, exports => {
    return exports
  })
}
