'use strict'

function run () {
  // eslint-disable-next-line no-unused-vars
  const nested = { foo: { bar: { baz: 42 } } }
  return 'my return value' // breakpoint at this line
}

function runWithHugeObject (propertyCount) {
  // eslint-disable-next-line no-unused-vars
  const huge = Object.fromEntries(Array.from({ length: propertyCount }, (_, i) => [`property${i}`, i]))
  return 'my return value' // breakpoint at this line
}

module.exports = { run, runWithHugeObject }
