'use strict'

const { inspect } = require('util')
require('../../setup/mocha')

const compile = require('../../../src/debugger/devtools_client/condition')

class CustomObject {}

const weakKey = { weak: 'key' }

const testCases = [
  // Plain references
  [{ ref: 'foo' }, { foo: 42 }, 42],
  [{ ref: 'foo' }, {}, new ReferenceError('foo is not defined')], // TODO: Will this actually throw in CDP?
  [{ getmember: [{ ref: 'obj' }, 'foo'] }, { obj: { foo: 'test-me' } }, 'test-me'],
  [
    { getmember: [{ getmember: [{ ref: 'obj' }, 'foo'] }, 'bar'] },
    { obj: { foo: { bar: 'test-me' } } },
    'test-me'
  ],
  [
    { getmember: [{ ref: 'set' }, 'foo'] },
    { set: new Set(['foo', 'bar']) },
    new Error('Aborting because accessing a Set or WeakSet is not allowed')
  ],
  [
    { getmember: [{ ref: 'wset' }, { ref: 'key' }] },
    { key: weakKey, wset: new WeakSet([weakKey]) },
    new Error('Aborting because accessing a Set or WeakSet is not allowed')
  ],
  [
    { getmember: [{ ref: 'map' }, 'foo'] },
    { map: new Map([['foo', 'bar']]) },
    new Error('Aborting because accessing a Map or WeakMap is not allowed')
  ],
  [
    { getmember: [{ ref: 'wmap' }, { ref: 'key' }] },
    { key: weakKey, wmap: new WeakMap([[weakKey, 'bar']]) },
    new Error('Aborting because accessing a Map or WeakMap is not allowed')
  ],
  [
    { getmember: [{ ref: 'obj' }, 'getter'] },
    { obj: Object.create(Object.prototype, { getter: { get () { return 'x' } } }) },
    new Error('Aborting because of possible side effects')
  ],

  // References with operations
  [{ len: { ref: 'foo' } }, { foo: 'hello' }, 5],
  [{ len: { getmember: [{ ref: 'obj' }, 'arr'] } }, { obj: { arr: Array(10).fill(0) } }, 10],
  [
    { len: { getmember: [{ ref: 'obj' }, 'unknownProp'] } },
    { obj: {} },
    new TypeError('Cannot read properties of undefined (reading \'length\')')
  ],
  [{ len: { ref: 'payload' } }, {}, new ReferenceError('payload is not defined')],

  // Index reference
  [{ index: [{ ref: 'arr' }, 1] }, { arr: ['foo', 'bar'] }, 'bar'],
  [{ index: [{ ref: 'arr' }, 100] }, { arr: ['foo', 'bar'] }, undefined], // Should throw according to spec
  [{ index: [{ ref: 'obj' }, 'foo'] }, { obj: { foo: 'bar' } }, 'bar'],
  [{ index: [{ ref: 'obj' }, 'bar'] }, { obj: { foo: 'bar' } }, undefined], // Should throw according to spec
  [
    { index: [{ ref: 'set' }, 'foo'] },
    { set: new Set(['foo']) },
    new Error('Aborting because accessing a Set or WeakSet is not allowed')
  ],
  [
    { index: [{ ref: 'set' }, 'bar'] },
    { set: new Set(['foo']) },
    new Error('Aborting because accessing a Set or WeakSet is not allowed')
  ],
  [{ index: [{ ref: 'map' }, 'foo'] }, { map: new Map([['foo', 'bar']]) }, 'bar'],
  [{ index: [{ ref: 'map' }, 'bar'] }, { map: new Map([['foo', 'bar']]) }, undefined], // Should throw according to spec
  [{ index: [{ ref: 'wmap' }, { ref: 'key' }] }, { key: weakKey, wmap: new WeakMap([[weakKey, 'bar']]) }, 'bar'],
  [
    { index: [{ ref: 'wmap' }, { ref: 'key' }] },
    { key: {}, wmap: new WeakMap([[weakKey, 'bar']]) },
    undefined // Should throw according to spec
  ],
  [
    { index: [{ ref: 'set' }, { ref: 'key' }] },
    { key: weakKey, set: new WeakSet([weakKey]) },
    new Error('Aborting because accessing a Set or WeakSet is not allowed')
  ],
  [
    { index: [{ ref: 'set' }, { ref: 'key' }] },
    { key: {}, set: new WeakSet([weakKey]) },
    new Error('Aborting because accessing a Set or WeakSet is not allowed')
  ],
  [
    { index: [{ ref: 'obj' }, 'getter'] },
    { obj: Object.create(Object.prototype, { getter: { get () { return 'x' } } }) },
    new Error('Aborting because of possible side effects')
  ],

  // Argument predicates and operations
  [{ eq: [{ ref: 'hits' }, true] }, { hits: true }, true],
  [{ eq: [{ ref: 'hits' }, null] }, { hits: null }, true],
  [{ substring: [{ ref: 'payload' }, 4, 7] }, { payload: 'hello world' }, 'hello world'.slice(4, 7)],
  [{ any: [{ ref: 'collection' }, { isEmpty: { ref: '@it' } }] }, { collection: ['foo', 'bar', ''] }, true],
  [{ any: [{ ref: 'coll' }, { isEmpty: { ref: '@value' } }] }, { coll: { 0: 'foo', 1: 'bar', 2: '' } }, true],
  [{ any: [{ ref: 'coll' }, { isEmpty: { ref: '@value' } }] }, { coll: { 0: 'foo', 1: 'bar', 2: 'baz' } }, false],
  [{ any: [{ ref: 'coll' }, { isEmpty: { ref: '@key' } }] }, { coll: { foo: 0, bar: 1, '': 2 } }, true],
  [{ any: [{ ref: 'coll' }, { isEmpty: { ref: '@key' } }] }, { coll: { foo: 0, bar: 1, baz: 2 } }, false],
  [{ startsWith: [{ ref: 'local_string' }, 'hello'] }, { local_string: 'hello world!' }, true],
  [{ startsWith: [{ ref: 'local_string' }, 'world'] }, { local_string: 'hello world!' }, false],
  [
    { filter: [{ ref: 'collection' }, { not: { isEmpty: { ref: '@it' } } }] },
    { collection: ['foo', 'bar', ''] },
    ['foo', 'bar']
  ],
  [
    { filter: [{ ref: 'collection' }, { not: { isEmpty: { ref: '@it' } } }] },
    { collection: new Set(['foo', 'bar', '']) },
    ['foo', 'bar']
  ],
  [
    { filter: [{ ref: 'collection' }, { not: { isEmpty: { ref: '@value' } } }] },
    { collection: { 1: 'foo', 2: 'bar', 3: '' } },
    { 1: 'foo', 2: 'bar' }
  ],
  [
    { filter: [{ ref: 'collection' }, { not: { isEmpty: { ref: '@key' } } }] },
    { collection: { foo: 1, bar: 2, '': 3 } },
    { foo: 1, bar: 2 }
  ],
  [{ contains: [{ ref: 'str' }, 'world'] }, { str: 'hello world' }, true],
  [{ contains: [{ ref: 'str' }, 'missing'] }, { str: 'hello world' }, false],
  [{ contains: [{ ref: 'arr' }, 'foo'] }, { arr: ['foo', 'bar'] }, true],
  [{ contains: [{ ref: 'arr' }, 'missing'] }, { arr: ['foo', 'bar'] }, false],
  [{ contains: [{ ref: 'arr' }, 'foo'] }, { arr: overloadMethod(['foo', 'bar'], 'includes') }, true],
  // TODO: Test TypedArray
  [{ contains: [{ ref: 'set' }, 'foo'] }, { set: new Set(['foo', 'bar']) }, true],
  [{ contains: [{ ref: 'set' }, 'missing'] }, { set: new Set(['foo', 'bar']) }, false],
  [{ contains: [{ ref: 'set' }, 'foo'] }, { set: overloadMethod(new Set(['foo', 'bar']), 'has') }, true],
  [{ contains: [{ ref: 'wset' }, { ref: 'key' }] }, { key: weakKey, wset: new WeakSet([weakKey]) }, true],
  [{ contains: [{ ref: 'wset' }, { ref: 'key' }] }, { key: {}, wset: new WeakSet([weakKey]) }, false],
  [
    { contains: [{ ref: 'wset' }, { ref: 'key' }] },
    { key: weakKey, wset: overloadMethod(new WeakSet([weakKey]), 'has') },
    true
  ],
  [{ contains: [{ ref: 'map' }, 'foo'] }, { map: new Map([['foo', 'bar']]) }, true],
  [{ contains: [{ ref: 'map' }, 'missing'] }, { map: new Map([['foo', 'bar']]) }, false],
  [{ contains: [{ ref: 'map' }, 'foo'] }, { map: overloadMethod(new Map([['foo', 'bar']]), 'has') }, true],
  [{ contains: [{ ref: 'wmap' }, { ref: 'key' }] }, { key: weakKey, wmap: new WeakMap([[weakKey, 'bar']]) }, true],
  [{ contains: [{ ref: 'wmap' }, { ref: 'key' }] }, { key: {}, wmap: new WeakMap([[weakKey, 'bar']]) }, false],
  [
    { contains: [{ ref: 'wmap' }, { ref: 'key' }] },
    { key: weakKey, wmap: overloadMethod(new WeakMap([[weakKey, 'bar']]), 'has') },
    true],
  [
    { contains: [{ ref: 'obj' }, 'foo'] },
    { obj: { foo: 'bar' } },
    new TypeError('Variable obj does not support contains')
  ],
  [
    { contains: [{ ref: 'obj' }, 'missing'] },
    { obj: { foo: 'bar' } },
    new TypeError('Variable obj does not support contains')
  ],
  // TODO: Ensure there's no side-effects due to Symbol.match
  [{ matches: [{ ref: 'foo' }, '[0-9]+'] }, { foo: '42' }, true],
  [{ matches: [{ ref: 'foo' }, { ref: 'regex' }] }, { foo: '42', regex: /[0-9]+/ }, true],
  [{ matches: [{ ref: 'foo' }, { ref: 'regex' }] }, { foo: '42', regex: overloadMethod(/[0-9]+/, 'test') }, true],

  // Undefined comparison
  [{ eq: [{ ref: 'foo' }, { ref: 'undefined' }] }, { foo: undefined }, true],
  [{ eq: [{ ref: 'foo' }, { ref: 'undefined' }] }, { foo: null }, false],
  [{ eq: [{ getmember: [{ ref: 'obj' }, 'foo'] }, { ref: 'undefined' }] }, { obj: { foo: undefined } }, true],
  [{ eq: [{ getmember: [{ ref: 'obj' }, 'foo'] }, { ref: 'undefined' }] }, { obj: {} }, true],
  [{ eq: [{ getmember: [{ ref: 'obj' }, 'foo'] }, { ref: 'undefined' }] }, { obj: { foo: null } }, false],

  // Literal values
  [42, {}, 42],
  [true, {}, true],
  [{ or: [{ ref: 'bar' }, { ref: 'foo' }] }, { bar: 42 }, 42],
  [{ and: [{ ref: 'bar' }, { ref: 'foo' }] }, { bar: 0 }, 0],
  [{ or: [{ ref: 'bar' }, { ref: 'foo' }] }, { bar: 0 }, new ReferenceError('foo is not defined')],
  [{ and: [{ ref: 'bar' }, { ref: 'foo' }] }, { bar: 42 }, new ReferenceError('foo is not defined')],
  [{ isDefined: 'foo' }, { bar: 42 }, false],
  [{ isDefined: 'bar' }, { bar: 42 }, true],
  [{ isDefined: 'bar' }, { bar: undefined }, true],
  // TODO: Ensure there's no side-effects due to Symbol.hasInstance
  [{ instanceof: [{ ref: 'bar' }, 'Object'] }, { bar: {} }, true],
  [{ instanceof: [{ ref: 'bar' }, 'Error'] }, { bar: new Error() }, true],
  [
    { instanceof: [{ ref: 'bar' }, 'CustomObject'] },
    { bar: new CustomObject(), CustomObject },
    true
  ]
  // TODO: Ensure there's no side-effects due to proxies
]

const definedTestCases = [
  [{ isDefined: 'foo' }, 'const foo = undefined', false],
  [{ isDefined: 'foo' }, 'const foo = 42', false],
  [{ isDefined: 'foo' }, 'let foo', false],
  [{ isDefined: 'foo' }, 'let foo = undefined', false],
  [{ isDefined: 'foo' }, 'let foo = 42', false],
  [{ isDefined: 'foo' }, 'var foo', true], // var is hoisted
  [{ isDefined: 'foo' }, 'var foo = undefined', true], // var is hoisted
  [{ isDefined: 'foo' }, 'var foo = 42', true], // var is hoisted
  [{ isDefined: 'foo' }, '', false]
]

describe('Expresion language condition compilation', function () {
  for (const [ast, data, expected] of testCases) {
    const code = Object
      .entries(data)
      .map(([key, value]) => `${key} = ${inspect(value)}`)
      .join('; ')
    it(`${JSON.stringify(ast)} + "${code}" = ${expected}`, function () {
      const fn = new Function(...Object.keys(data), `return ${compile(ast)}`) // eslint-disable-line no-new-func
      const args = Object.values(data)
      if (expected instanceof Error) {
        expect(() => fn(...args)).to.throw(expected.constructor, expected.message)
      } else {
        const result = runWithDebug(fn, args)
        expect(result).to.deep.equal(expected)
      }
    })
  }

  for (const [ast, postfix, expected] of definedTestCases) {
    it(`${JSON.stringify(ast)} + "${postfix}" = ${expected}`, function () {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`
        const result = (() => {
          return ${compile(ast)}
        })()
        ${postfix}
        return result
      `)
      const result = runWithDebug(fn)
      expect(result).to.deep.equal(expected)
    })
  }
})

function runWithDebug (fn, args = []) {
  try {
    return fn(...args)
  } catch (e) {
    // Output the compiled expression for easier debugging
    // eslint-disable-next-line no-console
    console.log([
      'Compiled expression:',
      '--------------------------------------------------------------------------------',
      fn.toString(),
      '--------------------------------------------------------------------------------'
    ].join('\n'))
    throw e
  }
}

function overloadMethod (obj, methodName) {
  obj[methodName] = () => { throw new Error('This should never throw!') }
  return obj
}
