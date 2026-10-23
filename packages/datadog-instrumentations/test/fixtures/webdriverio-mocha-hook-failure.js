'use strict'

// Run outside the repository's Mocha hooks, which suppress cascading teardown failures.
const { Context, Runner, Suite, Test } = require('mocha')

const { createEfdRetryPolicy } = require('../../../dd-trace/src/ci-visibility/efd-retry-policy')
const { channel } = require('../../src/helpers/instrument')
const {
  getOnFailHandler,
  getOnHookEndHandler,
  getOnTestEndHandler,
  getOnTestHandler,
  getOnTestRetryHandler,
  patchFailedTestReplayHookUp,
} = require('../../src/mocha/utils')

const scenario = JSON.parse(process.argv[2])
const videos = process.argv[3] === 'true'
const config = {
  isTestFailureVideosEnabled: videos,
  earlyFlakeDetectionRetryPolicy: createEfdRetryPolicy(),
}
const events = []
const finishes = []
patchFailedTestReplayHookUp(Runner)
const root = new Suite('', new Context())
const outer = Suite.create(root, 'outer')
const inner = Suite.create(outer, 'inner')
if (scenario.retry) inner.retries(1)
inner.beforeEach('setup', () => {
  events.push('setup')
  if (scenario.before) throw new Error('setup failed')
})
if (!scenario.noTeardown) {
  /** @type {Array<[string, import('mocha').Suite]>} */
  const suites = [['inner', inner], ['outer', outer], ['root', root]]
  for (const [name, suite] of suites) {
    suite.afterEach(name, async () => {
      await Promise.resolve()
      events.push(name)
      if (scenario[name]) throw new Error(`${name} failed`)
    })
  }
}
const test = new Test('attempt', () => {
  events.push('body')
  if (scenario.retry) throw new Error('retry me')
})
test.file = __filename
inner.addTest(test)
const runner = new Runner(root)
runner.on('test', getOnTestHandler(false))
runner.on('test end', getOnTestEndHandler(config))
runner.on('hook end', getOnHookEndHandler(config))
runner.on('fail', getOnFailHandler(false, config))
runner.on('retry', getOnTestRetryHandler(config))
channel('ci:mocha:test:finish').subscribe(context => {
  const { status, finalStatus } = /** @type {{status: string, finalStatus: string}} */ (context)
  finishes.push({ status, finalStatus })
  events.push('finish')
})
channel('ci:mocha:test:retry').subscribe(() => events.push('retry'))
channel('ci:mocha:after-each:finish').subscribe(ctx => {
  if (!videos) return
  const context = /** @type {{isWaiting: boolean, onDone: () => void}} */ (ctx)
  events.push('capture')
  context.isWaiting = true
  Promise.resolve().then(() => {
    events.push('captured')
    context.onDone()
  })
})
runner.run(failures => {
  runner.dispose()
  process.stdout.write(JSON.stringify({ events, failures, finishes }))
})
