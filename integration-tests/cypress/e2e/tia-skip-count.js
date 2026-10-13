/* eslint-disable */
const { getTestEnvironment } = require('../support/test-environment')

const suiteStartMode = getTestEnvironment('DD_SUITE_START_MODE')
if (suiteStartMode === 'late' || suiteStartMode === 'missing') {
  let suiteStartArgs
  let testStarts = 0
  // Exercise real skip tasks before the Node plugin receives the suite-start task.
  Cypress.Commands.overwrite('task', (originalTask, task, arg, options) => {
    if (task === 'dd:testSuiteStart') {
      suiteStartArgs = arg
      return originalTask('dd:log', `Suppressing suite start (${suiteStartMode})`, options)
    }
    if (task === 'dd:beforeEach' && ++testStarts === 2 && suiteStartMode === 'late') {
      return originalTask('dd:testSuiteStart', suiteStartArgs, options)
        .then(() => originalTask('dd:log', 'Restored suite start', options))
        .then(() => originalTask(task, arg, options))
    }
    return originalTask(task, arg, options)
  })
}

describe('suite', () => {
  it('TIA skip one', () => { throw new Error('TIA should skip this test') })
  it('TIA skip two', () => { throw new Error('TIA should skip this test') })
  it.skip('framework skip', () => { throw new Error('Framework should skip this test') })
  it('passing', () => { expect(true).to.equal(true) })
})
