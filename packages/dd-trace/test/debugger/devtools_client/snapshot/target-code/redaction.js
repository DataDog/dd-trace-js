'use strict'

function run () {
  const nonNormalizedSecretToken = '@Se-cret_$.'
  const foo = 'bar' // eslint-disable-line no-unused-vars
  const secret = 'shh!'
  const Se_cret_$ = 'shh!' // eslint-disable-line camelcase, no-unused-vars
  const weakMapKey = { secret: 'shh!' }
  const obj = {
    foo: 'bar',
    secret,
    [nonNormalizedSecretToken]: 'shh!',
    nested: { secret: 'shh!' },
    arr: [{ secret: 'shh!' }],
    map: new Map([
      ['foo', 'bar'],
      ['secret', 'shh!'],
      [nonNormalizedSecretToken, 'shh!'],
      [Symbol('secret'), 'shh!'],
      [Symbol(nonNormalizedSecretToken), 'shh!']
    ]),
    weakmap: new WeakMap([[weakMapKey, 42]]),
    [Symbol('secret')]: 'shh!',
    [Symbol(nonNormalizedSecretToken)]: 'shh!'
  }

  Object.defineProperty(obj, 'password', {
    value: 'shh!',
    enumerable: false
  })

  return obj // breakpoint at this line
}

module.exports = { run }
