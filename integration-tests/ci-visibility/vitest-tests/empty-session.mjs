import { beforeEach, describe, it } from 'vitest'

const mode = process.env.EMPTY_SESSION_MODE

if (mode !== 'empty') {
  const suite = mode === 'skip-suite' ? describe.skip : describe
  suite('empty session', () => {
    beforeEach(() => {
      if (mode === 'error') throw new Error('empty session hook failure')
    })
    it.skip('skipped test', () => { throw new Error('skipped test ran') })
    if (mode !== 'skip-tests') it('runnable test', () => {})
  })
}
