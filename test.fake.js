const { channel } = require('diagnostics_channel')
// to fake that we're loading a "manual" library, which triggers the creation of the ManualPlugin
// since there's no library to instrument here, we'd have to find a workaround
const instrumentationLoad = channel('dd-trace:instrumentation:load')
instrumentationLoad.publish({ name: 'manual' })

const testStartCh = channel('ci:manual:test:start')
const testEndCh = channel('ci:manual:test:end')

describe('can run tests', () => {
  beforeEach((test) => {
    testStartCh.publish(test)
    console.log('beforeEach', test)
  })
  afterEach((test) => {
    testEndCh.publish({ test, status: 'pass' })
    console.log('afterEach', test)
  })
  test('first', () => {
    console.log('first')
  })
  test('second', () => {
    console.log('second')
  })
})
