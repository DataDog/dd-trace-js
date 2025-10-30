'use strict'

const assert = require('assert')

/* eslint-disable-next-line n/no-missing-import */
import('d3-format').then(({ format }) => {
  const siFormat = format('.4~s')

  // This is `1.2undefined` when unexpectedly patched by import-in-the-middle.
  assert.equal(siFormat(1200), '1.2k')
})
