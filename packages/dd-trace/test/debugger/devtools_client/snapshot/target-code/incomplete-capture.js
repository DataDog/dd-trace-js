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

function runWithManyLocals () {
  /* eslint-disable no-unused-vars */
  const first = 1
  const second = 2
  const third = 3
  /* eslint-enable no-unused-vars */
  return 'my return value' // breakpoint at this line
}

function runWithRedactedValues () {
  /* eslint-disable no-unused-vars */
  const password = 'x'.repeat(300)
  const secret = { nested: { deeper: { deepest: 42 } } }
  /* eslint-enable no-unused-vars */
  return 'my return value' // breakpoint at this line
}

function runWithRedactedObject () {
  // eslint-disable-next-line no-unused-vars
  const password = { nested: { deeper: 42 } }
  return 'my return value' // breakpoint at this line
}

function runWithRedactedObjectAndClosure () {
  const fromClosure = { foo: 'bar' }
  return function inner () {
    // eslint-disable-next-line no-unused-vars
    const password = { nested: { deeper: 42 } }
    return fromClosure // breakpoint at this line
  }
}

module.exports = {
  run,
  runWithHugeObject,
  runWithManyLocals,
  runWithRedactedValues,
  runWithRedactedObject,
  runWithRedactedObjectAndClosure,
}
