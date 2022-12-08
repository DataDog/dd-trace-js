const Mocha = require('mocha')

const mocha = new Mocha()
mocha.addFile(require.resolve('./test/ci-visibility-test.js'))
mocha.run(() => {
  process.send('finished')
})
