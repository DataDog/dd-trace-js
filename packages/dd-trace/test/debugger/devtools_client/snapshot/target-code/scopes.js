'use strict'

/* eslint-disable no-unused-vars */
const foo = 'foo'
const bar = 'bar'
/* eslint-enable no-unused-vars */

function run (a1 = 1, a2 = 2) {
  let total = 0
  for (let i = 0; i < 3; i++) {
    const inc = 2
    // eslint-disable-next-line no-unused-vars
    total += inc // breakpoint at this line
  }
}

module.exports = { run }
