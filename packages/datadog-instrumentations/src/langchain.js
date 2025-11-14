'use strict'

const { addHook } = require('./helpers/instrument')

// langchain compiles into ESM and CommonJS, with ESM being the default and landing in the `.js` files
// however, CommonJS ends up in `cjs` files, and are required under the hood with `.cjs` files
// we patch each separately and explicitly to match against exports only once, and not rely on file regex matching
const extensions = ['js', 'cjs']

// TODO: Can we avoid looping? We should only need to know about the entrypoint
// for the plugin to load.
for (const extension of extensions) {
  const files = [
    `dist/runnables/base.${extension}`,
    `dist/language_models/chat_models.${extension}`,
    `dist/language_models/llms.${extension}`,
    `dist/tools/index.${extension}`,
    `dist/vectorstores.${extension}`,
    `dist/embeddings.${extension}`
  ]

  for (const file of files) {
    addHook({ name: '@langchain/core', versions: ['>=0.1'], file }, exports => exports)
  }
}
