const Mocha = require('mocha')

const mocha = new Mocha()
mocha.addFile(require.resolve('./test/ci-visibility-test.js'))
mocha.addFile(require.resolve('./test/ci-visibility-test-2.js'))
mocha.run(() => {
  if (process.send) {
    process.send('finished')
  }
})
