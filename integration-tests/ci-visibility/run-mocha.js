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
mocha.run(() => {
  if (process.send) {
    process.send('finished')
  }
}).on('end', () => {
  // eslint-disable-next-line
  console.log('end event: can add event listeners to mocha')
})
