import { startVitest } from 'vitest/node'

const keepServerOpenReporter = {
  onInit (vitest) {
    vitest.shouldKeepServer = () => true
  },
}

async function runProgrammaticTests () {
  let vitest
  try {
    vitest = await startVitest('test', ['./tia-programmatic-first.mjs'], {
      test: {
        environment: 'node',
      },
      reporters: [keepServerOpenReporter],
      watch: false,
    })

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
