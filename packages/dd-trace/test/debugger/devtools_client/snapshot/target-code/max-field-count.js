'use strict'

function run () {
  const obj = {}

  // 40 is larger the default maxFieldCount of 20
  for (let i = 1; i <= 40; i++) {
    obj[`field${i}`] = i
  }

  return 'my return value' // breakpoint at this line
}

module.exports = { run }
