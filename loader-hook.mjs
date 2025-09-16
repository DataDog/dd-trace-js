// export * from 'import-in-the-middle/hook.mjs'

import * as iitm from 'import-in-the-middle/hook.mjs'
import hooks from './packages/datadog-instrumentations/src/helpers/hooks.js'

const nodules = Object.keys(hooks)

function initialize (data = {}) {
  data.include ??= []
  data.exclude ??= []
  data.exclude.push(
    /middle/,
    /langsmith/,
    /openai\/_shims/,
    /openai\/resources\/chat\/completions\/messages/,
    /openai\/agents-core\/dist\/shims/,
    /@anthropic-ai\/sdk\/_shims/
  )

  for (const nodule of nodules) {
    data.include.push(new RegExp(`node_modules/${nodule}`), nodule)
    data.exclude.push(new RegExp(`node_modules/${nodule}/node_modules`))
  }

  return iitm.initialize(data)
}

export { initialize }
export { load, getFormat, resolve, getSource } from 'import-in-the-middle/hook.mjs'
