import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { createVitest } from 'vitest/node'

import { getVitestOptions, usesModeArgument } from './options.mjs'

const file = path.resolve('ci-visibility/vitest-tests/annotation-reuse.mjs')
const stages = [
  { name: 'first', annotated: true, retry: undefined },
  { name: 'removed', annotated: false, retry: undefined },
  { name: 'native', annotated: true, retry: 1 },
]
function writeStage ({ name, annotated, retry }) {
  const callback = `() => {
    appendFileSync(process.env.EXCLUSIONS_LEDGER, JSON.stringify('${name}') + '\\n')
    throw new Error('reused failure')
  }`
  const declaration = annotated ? `preventFailureSuppression(noAutoRetry(${callback}))` : callback
  writeFileSync(file, `import { appendFileSync } from 'node:fs'
import { test } from 'vitest'
import { noAutoRetry, preventFailureSuppression } from 'dd-trace/test-optimization.js'
test('reused', ${retry === undefined ? '' : `{ retry: ${retry} }, `}${declaration})
`)
}
writeStage(stages[0])
const options = getVitestOptions({ watch: false })
const vitest = usesModeArgument ? await createVitest('test', options) : await createVitest(options)
try {
  await vitest.start([file])
  for (const stage of stages.slice(1)) {
    writeStage(stage)
    if (vitest.invalidateFile) {
      vitest.invalidateFile(file)
    } else {
      // Vitest 1 exposes these same invalidation steps through its native watcher.
      vitest.invalidates.add(file)
      for (const { server } of vitest.projects) {
        for (const module of server.moduleGraph.getModulesByFile(file) || []) {
          server.moduleGraph.invalidateModule(module)
        }
      }
    }
    await vitest.rerunFiles([file])
  }
} finally {
  await vitest.close()
}
