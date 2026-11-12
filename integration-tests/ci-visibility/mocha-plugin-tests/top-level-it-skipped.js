'use strict'

const mode = process.env.MOCHA_TOP_LEVEL_SKIP_MODE
const firstIt = mode === 'last' ? it : it.skip
const secondIt = mode === 'first' ? it : it.skip

firstIt('first top-level test', () => {})
secondIt('second top-level test', () => {})

if (mode === 'mixed') {
  describe('nested suite', () => {
    it('nested passing test', () => {})
  })
}
