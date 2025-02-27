'use strict'

const Mocha = require('mocha')

const mocha = new Mocha({
  parallel: !!process.env.RUN_IN_PARALLEL
})
if (process.env.TESTS_TO_RUN) {
  const tests = JSON.parse(process.env.TESTS_TO_RUN)
  tests.forEach(test => {
    mocha.addFile(require.resolve(test))
  })
} else {
  mocha.addFile(require.resolve('./test/ci-visibility-test.js'))
  mocha.addFile(require.resolve('./test/ci-visibility-test-2.js'))
}
mocha.run((failures) => {
  if (process.send) {
    process.send('finished')
  }
  if (process.env.SHOULD_CHECK_RESULTS && failures > 0) {
    process.exit(1)
  }
}).on('end', (res) => {
  // eslint-disable-next-line
  console.log('end event: can add event listeners to mocha')
})
