import { startVitest } from 'vitest/node'
import { getVitestOptions, usesModeArgument } from './options.mjs'

const testFile = process.env.TEST_DIR || 'ci-visibility/vitest-tests/vitest-worker-env.mjs'

async function runProgrammaticTests () {
  let vitest
  let didCollectWithoutFailures = false
  try {
    const options = getVitestOptions({
      run: false,
      test: {
        environment: 'node',
        pool: process.env.POOL_CONFIG || 'forks',
      },
      watch: false,
    })
    vitest = usesModeArgument
      ? await startVitest('test', [], options)
      : await startVitest([], options)

    const testSpecifications = await vitest.globTestSpecifications([testFile])
    await vitest.collectTests(testSpecifications)
    didCollectWithoutFailures = true
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`)
    process.exitCode = 1
  } finally {
    if (vitest) {
      await vitest.close()
    }
    if (didCollectWithoutFailures) {
      process.exit(0)
    }
  }
}

runProgrammaticTests()
