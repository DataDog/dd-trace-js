import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const vitestMajor = Number.parseInt(require('vitest/package.json').version, 10)
const runnerModule = await import(vitestMajor >= 5 ? 'vitest' : 'vitest' + '/runners')
const VitestTestRunner = runnerModule.TestRunner || runnerModule.VitestTestRunner

export default class CollectOnlyRunner extends VitestTestRunner {
  runSuite () {
    // Leave collected child tasks without execution results.
  }
}
