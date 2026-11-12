import assert from 'node:assert/strict'

import { createVitest, startVitest } from 'vitest/node'

import { usesModeArgument } from './options.mjs'

const overrides = process.env.READONLY_VITEST_OPTIONS === 'overrides'
  ? Object.freeze({})
  : { plugins: Object.freeze([]) }
const options = { config: false, watch: false, run: false, passWithNoTests: true, include: [] }
const args = usesModeArgument ? ['test'] : []
const method = process.env.VITEST_PROGRAMMATIC_METHOD === 'createVitest' ? createVitest : startVitest
if (method === startVitest) args.push([])
args.push(options, overrides)
let vitest
try {
  vitest = await method(...args)
  assert.strictEqual(overrides.plugins?.length || 0, 0)
} finally {
  await vitest?.close()
}
