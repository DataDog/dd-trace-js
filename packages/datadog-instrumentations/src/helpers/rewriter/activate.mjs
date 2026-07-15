import activation from './activation.js'

const { report } = activation
const parameters = new URL(import.meta.url).searchParams

report({
  name: parameters.get('name'),
  version: parameters.get('version'),
  file: parameters.get('file'),
})
