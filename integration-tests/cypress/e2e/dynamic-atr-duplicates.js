/* eslint-disable */

const { setTestEnvironment } = require('../support/test-environment')

for (const durations of [[1, 5100], [5100, 1]]) {
  describe(`durations ${durations.join(',')}`, () => {
    for (const duration of durations) {
      it('duplicate title', function () {
        setTestEnvironment('DYNAMIC_ATR_DURATION_MS', duration)
        cy.task('dd:addTags', { 'fixture.duration': String(duration) }).then(() => {
          if (duration === 1 || this.test.currentRetry() < 3) {
            throw new Error(`failure with duration ${duration}`)
          }
        })
      })
    }
  })
}
