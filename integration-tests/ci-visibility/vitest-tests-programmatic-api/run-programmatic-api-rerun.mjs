import { createVitest } from 'vitest/node'

async function runProgrammaticTests () {
  let vitest
  try {
    vitest = await createVitest('test', {
      test: {
        environment: 'node',
      },
      watch: false,
    })

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
