import { startVitest } from 'vitest/node'
import { getVitestOptions, usesModeArgument } from './options.mjs'

async function runProgrammaticTests () {
  try {
    const options = getVitestOptions({
      test: {
        environment: 'node',
      },
      run: true,
      watch: false,
    })
    const vitest = usesModeArgument
      ? await startVitest('test', [], options)
      : await startVitest([], options)

    await vitest.close()
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error)
    process.exit(1)
  }
}

runProgrammaticTests()
