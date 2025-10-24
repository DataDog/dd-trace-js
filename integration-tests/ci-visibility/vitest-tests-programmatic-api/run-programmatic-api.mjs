import { startVitest } from 'vitest/node'

async function runProgrammaticTests () {
  try {
    const vitest = await startVitest('test', [], {
      test: {
        environment: 'node',
      },
      run: true,
      watch: false
    })

    await vitest.close()
  } catch (error) {
    process.exit(1)
  }
}

runProgrammaticTests()
