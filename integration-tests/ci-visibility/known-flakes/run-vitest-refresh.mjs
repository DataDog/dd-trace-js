import { once } from 'node:events'

import { startVitest } from 'vitest/node'

import { usesModeArgument } from '../vitest-tests-programmatic-api/options.mjs'

const files = process.argv.slice(2)
const options = {
  config: false,
  root: process.cwd(),
  include: files,
  watch: false,
  maxWorkers: 1,
  minWorkers: 1,
  retry: Number(process.env.NATIVE_RETRIES),
  reporters: [{ onInit (vitest) { vitest.shouldKeepServer = () => true } }],
}
let vitest
try {
  vitest = usesModeArgument
    ? await startVitest('test', [files[0]], options)
    : await startVitest([files[0]], options)
  for (let index = 1; index < files.length; index++) {
    const resumed = once(process, 'message')
    process.send({ completed: index })
    await resumed
    const specifications = await vitest.globTestSpecifications([files[index]])
    await vitest.runTestSpecifications(specifications)
  }
} finally {
  await vitest?.close()
  process.disconnect()
}
