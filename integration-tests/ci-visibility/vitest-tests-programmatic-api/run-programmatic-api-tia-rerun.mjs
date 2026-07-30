import { startVitest } from 'vitest/node'

async function runProgrammaticTests () {
  let vitest
  try {
    vitest = await startVitest('test', ['./tia-programmatic-first.mjs'], {
      test: {
        environment: 'node',
      },
      run: true,
      watch: false,
    })

    if (!vitest) {
      throw new Error('Vitest did not start')
    }
    await vitest.runTestFiles(['./tia-programmatic-second.mjs'])
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
