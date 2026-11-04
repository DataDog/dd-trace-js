'use strict'

const { noAutoRetry } = require('dd-trace/ci/test-annotations')

const callbacks = [
  noAutoRetry(() => {
    if (process.env.EXCLUSIONS_EXCLUDED_FAILS === '1') throw new Error('excluded failure')
  }),
  () => { throw new Error('ordinary failure') },
]
if (process.env.EXCLUSIONS_EXCLUDED_FIRST !== '1') callbacks.reverse()

for (const callback of callbacks) it('duplicate', callback)
