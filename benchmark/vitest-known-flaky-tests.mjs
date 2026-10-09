// node --experimental-vm-modules benchmark/vitest-known-flaky-tests.mjs /tmp/baseline-vitest-setup.mjs
// node --experimental-vm-modules benchmark/vitest-known-flaky-tests.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm'

const source = readFileSync(process.argv[2] || 'ci/vitest-no-worker-init-setup.mjs', 'utf8')

for (const size of [10, 1000, 10000]) {
  const samples = []
  for (let sample = 0; sample < 8; sample++) {
    const file = { filepath: 'suite.js', tasks: [] }
    file.file = file
    const names = []
    const tests = []
    // Many nested suites must reuse the same file's index.
    for (let group = 0; group < size / 10; group++) {
      const suite = { type: 'suite', name: `group ${group}`, file, tasks: [] }
      file.tasks.push(suite)
      for (let index = 0; index < 10; index++) {
        const name = `parameterized test with example ${index}`
        names.push(`${suite.name} ${name}`)
        const test = {
          type: 'test',
          name: index % 2 ? `${name} missing` : name,
          file,
          suite,
          retry: { count: 2, __ddTestOptAtr: true },
          meta: {},
        }
        suite.tasks.push(test)
        tests.push(test)
      }
    }
    const providedContext = {
      isActive: true,
      flakyTests: { 'suite.js': names },
      flakyTestRetriesConfiguration: { includesUnnamedProject: true },
    }
    let beforeSuite
    const context = createContext({ performance })
    const vitest = new SyntheticModule(['afterEach', 'beforeAll', 'beforeEach', 'inject'], function () {
      this.setExport('afterEach', () => {})
      this.setExport('beforeAll', fn => { beforeSuite = fn })
      this.setExport('beforeEach', () => {})
      this.setExport('inject', () => providedContext)
    }, { context })
    const setup = new SourceTextModule(source, { context })
    await setup.link(() => vitest)
    await setup.evaluate()
    const start = performance.now()
    // Include index construction and the complete task walk through the real setup hook.
    await beforeSuite({}, file)
    const elapsed = performance.now() - start
    for (const [index, test] of tests.entries()) {
      assert.strictEqual(test.retry, index % 2 ? 0 : 2)
    }
    if (sample > 0) samples.push(elapsed)
  }
  samples.sort((a, b) => a - b)
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ size, nestedSuites: size / 10, medianMsPerFile: samples[3] }))
}
