import { createVitest } from 'vitest/node'
import { getVitestOptions, usesModeArgument } from './options.mjs'

const options = getVitestOptions({ watch: false })
const vitest = usesModeArgument ? await createVitest('test', options) : await createVitest(options)
const directory = 'ci-visibility/vitest-tests-programmatic-api'
const retries = []

try {
  if (vitest.standalone) await vitest.standalone()
  else await vitest.init()
  for (const file of ['dynamic-atr-first.mjs', 'dynamic-atr-second.mjs', 'dynamic-atr-first.mjs']) {
    if (retries.length === 2) {
      for (const project of vitest.projects) project.config.retry = 4
    }
    const specifications = await vitest.globTestSpecifications([`${directory}/${file}`])
    if (vitest.runTestSpecifications) await vitest.runTestSpecifications(specifications)
    else await vitest.runFiles(specifications)
    const task = vitest.state.getFiles().find(task => task.filepath.endsWith(file))
    retries.push(task.tasks[0].result.retryCount)
  }
  // eslint-disable-next-line no-console
  console.log(`DYNAMIC_ATR_RERUNS ${JSON.stringify(retries)}`)
} finally {
  await vitest.close()
}
