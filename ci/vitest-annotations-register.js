'use strict'

// Vitest's no-worker mode uses Node >=18.19, which provides module.register.
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const { register } = require('node:module')
const { pathToFileURL } = require('node:url')

const { Hook } = require('import-in-the-middle')
const { wrapDeclaration } = require('../packages/dd-trace/src/ci-visibility/test-declaration-annotations')

// No worker tracer is initialized. Intercept only the Vitest declaration modules.
register('import-in-the-middle/hook.mjs', pathToFileURL(__filename), {
  data: { include: [/\/node_modules\/(?:@vitest\/runner|vitest)\/dist\//] },
})

Hook(pkg => {
  const getCurrentSuite = Object.values(pkg).find(value =>
    typeof value === 'function' && value.name === 'getCurrentSuite'
  )
  if (!getCurrentSuite) return
  for (const [name, value] of Object.entries(pkg)) {
    if (typeof value === 'function' && 'each' in value && 'extend' in value) {
      pkg[name] = wrapDeclaration(value, getCurrentSuite)
    }
  }
})
