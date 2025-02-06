'use strict'

function run () {
  // local scope
  const { a1, b1, c1, d1 } = {}

  {
    // block scope
    const { a2, b2, c2, d2 } = {}

    return { a1, b1, c1, d1, a2, b2, c2, d2 } // breakpoint at this line
  }
}

module.exports = { run }
