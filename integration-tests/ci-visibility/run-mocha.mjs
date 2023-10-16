import Mocha from 'mocha'
import { fileURLToPath } from 'url'

const mocha = new Mocha({
  parallel: !!process.env.RUN_IN_PARALLEL
})

if (process.env.TESTS_TO_RUN) {
  const tests = JSON.parse(process.env.TESTS_TO_RUN)
  tests.forEach(test => {
    mocha.addFile(fileURLToPath(new URL(test), import.meta.url))
  })
} else {
  mocha.addFile(fileURLToPath(new URL('./test/ci-visibility-test.js', import.meta.url)))
  mocha.addFile(fileURLToPath(new URL('./test/ci-visibility-test-2.js', import.meta.url)))
}

mocha.run(() => {
  if (process.send) {
    process.send('finished')
  }
}).on('end', () => {
  // eslint-disable-next-line
  console.log('end event: can add event listeners to mocha')
})
