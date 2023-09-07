import Mocha from 'mocha'
import { fileURLToPath } from 'url'

const mocha = new Mocha({
  parallel: !!process.env.RUN_IN_PARALLEL
})
mocha.addFile(fileURLToPath(new URL('./test/ci-visibility-test.js', import.meta.url)))
mocha.addFile(fileURLToPath(new URL('./test/ci-visibility-test-2.js', import.meta.url)))
mocha.run(() => {
  if (process.send) {
    process.send('finished')
  }
}).on('end', () => {
  // eslint-disable-next-line
  console.log('end event: can add event listeners to mocha')
})
