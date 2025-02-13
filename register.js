const { register } = require('node:module')
const { pathToFileURL } = require('node:url')

register('./loader-hook.mjs', pathToFileURL(__filename), {
  data: { exclude: [/langsmith/, /openai\/_shims/, /openai\/resources\/chat\/completions\/messages/] }
})
