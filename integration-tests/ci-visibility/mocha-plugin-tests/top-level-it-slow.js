'use strict'

it('top-level slow test', () => {
  const waitBuffer = new SharedArrayBuffer(4)
  const waitArray = new Int32Array(waitBuffer)
  Atomics.wait(waitArray, 0, 0, 200)
})
