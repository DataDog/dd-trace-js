/* eslint-disable */

for (const order of [['pass', 'fail'], ['fail', 'pass']]) {
  describe(order.join(','), () => {
    for (const result of order) {
      describe('duplicate', () => {
        it('title', () => {
          cy.task('dd:addTags', { 'fixture.result': result, 'fixture.order': order.join(',') })
        })

        if (result === 'fail') {
          after(() => {
            throw new Error(`late failure for ${order.join(',')}`)
          })
        }
      })
    }
  })
}
