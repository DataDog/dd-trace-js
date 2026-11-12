import { startVitest } from 'vitest/node'
import { getVitestOptions, usesModeArgument } from './options.mjs'

async function runProgrammaticTests () {
  let vitest
  try {
    const options = getVitestOptions({
      test: {
        environment: 'node',
      },
      watch: true,
    })
    vitest = usesModeArgument
      ? await startVitest('test', ['./tia-programmatic-first.mjs'], options)
      : await startVitest(['./tia-programmatic-first.mjs'], options)

    const globTestSpecifications = vitest.globTestSpecifications || vitest.globTestFiles
    const testSpecifications = await globTestSpecifications.call(vitest, ['./tia-programmatic-second.mjs'])
    await vitest.runTestSpecifications(testSpecifications)
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
