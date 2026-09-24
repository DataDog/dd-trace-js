import { createVitest } from 'vitest/node'
import { getVitestOptions, usesModeArgument } from './options.mjs'

async function runProgrammaticTests () {
  let vitest
  try {
    const options = getVitestOptions({
      test: {
        environment: 'node',
      },
      watch: false,
    })
    vitest = usesModeArgument
      ? await createVitest('test', options)
      : await createVitest(options)

    await vitest.standalone()
    await vitest.runTestFiles(['./test-programmatic-api-first.mjs'])
    await vitest.runTestFiles(['./test-programmatic-api-second.mjs'])
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`)
    process.exitCode = 1
  } finally {
    if (vitest) {
      await vitest.close()
    }
  }
}

runProgrammaticTests()
