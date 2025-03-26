'use strict'

function run () {
  // eslint-disable-next-line no-unused-vars
  const myNestedObj = {
    deepObj: { foo: { foo: { foo: { foo: { foo: true } } } } },
    deepArr: [[[[[42]]]]]
  }
  return 'my return value' // breakpoint at this line
}

module.exports = { run }
