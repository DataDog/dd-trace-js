'use strict'

require('../../setup/mocha')

const compile = require('../../../src/debugger/devtools_client/condition')

class CustomObject {}
class SideEffectObject {
  static [Symbol.hasInstance] () {
    throw new Error('This should never throw!')
  }
}
const weakKey = { weak: 'key' }

process[Symbol.for('datadog:isProxy')] = require('util').types.isProxy

const testCases = [
  [{ ref: 'foo' }, { foo: 42 }, 42],
  [{ ref: 'foo' }, {}, new ReferenceError('foo is not defined')],

  [{ getmember: [{ ref: 'obj' }, 'foo'] }, { obj: { foo: 'test-me' } }, 'test-me'],
  [
    { getmember: [{ getmember: [{ ref: 'obj' }, 'foo'] }, 'bar'] },
    { obj: { foo: { bar: 'test-me' } } },
    'test-me'
  ],
  [
    { getmember: [{ ref: 'set' }, 'foo'] },
    { set: new Set(['foo', 'bar']) },
    new Error('Accessing a Set or WeakSet is not allowed')
  ],
  [
    { getmember: [{ ref: 'wset' }, { ref: 'key' }] },
    { key: weakKey, wset: new WeakSet([weakKey]) },
    new Error('Accessing a Set or WeakSet is not allowed')
  ],
  [
    { getmember: [{ ref: 'map' }, 'foo'] },
    { map: new Map([['foo', 'bar']]) },
    new Error('Accessing a Map or WeakMap is not allowed')
  ],
  [
    { getmember: [{ ref: 'wmap' }, { ref: 'key' }] },
    { key: weakKey, wmap: new WeakMap([[weakKey, 'bar']]) },
    new Error('Accessing a Map or WeakMap is not allowed')
  ],
  [
    { getmember: [{ ref: 'obj' }, 'getter'] },
    { obj: Object.create(Object.prototype, { getter: { get () { return 'x' } } }) },
    new Error('Possibility of side effect')
  ],

  [{ len: { ref: 'str' } }, { str: 'hello' }, 5],
  [{ len: { ref: 'str' } }, { str: String('hello') }, 5],
  [{ len: { ref: 'str' } }, { str: new String('hello') }, 5], // eslint-disable-line no-new-wrappers
  [{ len: { ref: 'arr' } }, { arr: [1, 2, 3] }, 3],
  [{ len: { ref: 'set' } }, { set: new Set([1, 2]) }, 2],
  [
    { len: { ref: 'set' } },
    { set: overloadPropertyWithGetter(new Set([1, 2]), 'size') },
    new Error('Possibility of side effect')
  ],
  [{ len: { ref: 'map' } }, { map: new Map([[1, 2]]) }, 1],
  [
    { len: { ref: 'map' } },
    { map: overloadPropertyWithGetter(new Map([[1, 2]]), 'size') },
    new Error('Possibility of side effect')
  ],
  [
    { len: { ref: 'wset' } },
    { wset: new WeakSet([weakKey]) },
    new TypeError('Variable does not support len/count')],
  [
    { len: { ref: 'wmap' } },
    { wmap: new WeakMap([[weakKey, 2]]) },
    new TypeError('Variable does not support len/count')
  ],
  [{ len: { getmember: [{ ref: 'obj' }, 'arr'] } }, { obj: { arr: Array(10).fill(0) } }, 10],
  [{ len: { getmember: [{ ref: 'obj' }, 'tarr'] } }, { obj: { tarr: new Int16Array([10, 20, 30]) } }, 3],
  [
    { len: { getmember: [{ ref: 'obj' }, 'tarr'] } },
    { obj: { tarr: overloadPropertyWithGetter(new Int16Array([10, 20, 30]), 'length') } },
    new Error('Possibility of side effect')
  ],
  [
    { len: { getmember: [{ ref: 'obj' }, 'unknownProp'] } },
    { obj: {} },
    new TypeError('Variable does not support len/count')
  ],
  [{ len: { ref: 'invalid' } }, {}, new ReferenceError('invalid is not defined')],

  // `count` should be implemented as a synonym for `len`, so we shouldn't need to test it as thoroughly
  [{ count: { ref: 'str' } }, { str: 'hello' }, 5],
  [{ count: { ref: 'arr' } }, { arr: [1, 2, 3] }, 3],

  [{ index: [{ ref: 'arr' }, 1] }, { arr: ['foo', 'bar'] }, 'bar'],
  [{ index: [{ ref: 'arr' }, 100] }, { arr: ['foo', 'bar'] }, undefined], // Should throw according to spec
  [{ index: [{ ref: 'obj' }, 'foo'] }, { obj: { foo: 'bar' } }, 'bar'],
  [{ index: [{ ref: 'obj' }, 'bar'] }, { obj: { foo: 'bar' } }, undefined], // Should throw according to spec
  [
    { index: [{ ref: 'set' }, 'foo'] },
    { set: new Set(['foo']) },
    new Error('Accessing a Set or WeakSet is not allowed')
  ],
  [
    { index: [{ ref: 'set' }, 'bar'] },
    { set: new Set(['foo']) },
    new Error('Accessing a Set or WeakSet is not allowed')
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
    new Error('Accessing a Set or WeakSet is not allowed')
  ],
  [
    { index: [{ ref: 'set' }, { ref: 'key' }] },
    { key: {}, set: new WeakSet([weakKey]) },
    new Error('Accessing a Set or WeakSet is not allowed')
  ],
  [
    { index: [{ ref: 'obj' }, 'getter'] },
    { obj: Object.create(Object.prototype, { getter: { get () { return 'x' } } }) },
    new Error('Possibility of side effect')
  ],

  [{ eq: [{ ref: 'str' }, 'foo'] }, { str: 'foo' }, true],
  [{ eq: [{ ref: 'str' }, 'foo'] }, { str: 'bar' }, false],
  [{ eq: [{ ref: 'str' }, 'foo'] }, { str: String('foo') }, true],
  [{ eq: [{ ref: 'str' }, 'foo'] }, { str: String('bar') }, false],
  // TODO: Is this the expected behavior?
  [{ eq: [{ ref: 'str' }, 'foo'] }, { str: new String('foo') }, false], // eslint-disable-line no-new-wrappers
  [{ eq: [{ ref: 'bool' }, true] }, { bool: true }, true],
  [{ eq: [{ ref: 'nil' }, null] }, { nil: null }, true],
  [{ eq: [{ ref: 'foo' }, { ref: 'undefined' }] }, { foo: undefined }, true],
  [{ eq: [{ ref: 'foo' }, { ref: 'undefined' }] }, { foo: null }, false],
  [{ eq: [{ getmember: [{ ref: 'obj' }, 'foo'] }, { ref: 'undefined' }] }, { obj: { foo: undefined } }, true],
  [{ eq: [{ getmember: [{ ref: 'obj' }, 'foo'] }, { ref: 'undefined' }] }, { obj: {} }, true],
  [{ eq: [{ getmember: [{ ref: 'obj' }, 'foo'] }, { ref: 'undefined' }] }, { obj: { foo: null } }, false],
  [{ eq: [{ or: [true, false] }, { and: [true, false] }] }, {}, false],

  [{ ne: [{ ref: 'str' }, 'foo'] }, { str: 'foo' }, false],
  [{ ne: [{ ref: 'str' }, 'foo'] }, { str: 'bar' }, true],
  [{ ne: [{ ref: 'str' }, 'foo'] }, { str: String('foo') }, false],
  [{ ne: [{ ref: 'str' }, 'foo'] }, { str: String('bar') }, true],
  // TODO: Is this the expected behavior?
  [{ ne: [{ ref: 'str' }, 'foo'] }, { str: new String('foo') }, true], // eslint-disable-line no-new-wrappers
  [{ ne: [{ ref: 'bool' }, true] }, { bool: true }, false],
  [{ ne: [{ ref: 'nil' }, null] }, { nil: null }, false],
  [{ ne: [{ or: [false, true] }, { and: [true, false] }] }, {}, true],

  [{ gt: [{ ref: 'num' }, 42] }, { num: 43 }, true],
  [{ gt: [{ ref: 'num' }, 42] }, { num: 42 }, false],
  [{ gt: [{ ref: 'num' }, 42] }, { num: 41 }, false],
  [{ gt: [{ ref: 'str' }, 'a'] }, { str: 'b' }, true],
  [{ gt: [{ ref: 'str' }, 'a'] }, { str: 'a' }, false],
  [{ gt: [{ ref: 'str' }, 'b'] }, { str: 'a' }, false],
  [{ gt: [{ or: [2, 0] }, { and: [1, 1] }] }, {}, true],

  [{ ge: [{ ref: 'num' }, 42] }, { num: 43 }, true],
  [{ ge: [{ ref: 'num' }, 42] }, { num: 42 }, true],
  [{ ge: [{ ref: 'num' }, 42] }, { num: 41 }, false],
  [{ ge: [{ ref: 'str' }, 'a'] }, { str: 'b' }, true],
  [{ ge: [{ ref: 'str' }, 'a'] }, { str: 'a' }, true],
  [{ ge: [{ ref: 'str' }, 'b'] }, { str: 'a' }, false],
  [{ ge: [{ or: [1, 0] }, { and: [1, 2] }] }, {}, false],

  [{ lt: [{ ref: 'num' }, 42] }, { num: 43 }, false],
  [{ lt: [{ ref: 'num' }, 42] }, { num: 42 }, false],
  [{ lt: [{ ref: 'num' }, 42] }, { num: 41 }, true],
  [{ lt: [{ ref: 'str' }, 'a'] }, { str: 'b' }, false],
  [{ lt: [{ ref: 'str' }, 'a'] }, { str: 'a' }, false],
  [{ lt: [{ ref: 'str' }, 'b'] }, { str: 'a' }, true],
  [{ lt: [{ or: [1, 0] }, { and: [1, 0] }] }, {}, false],

  [{ le: [{ ref: 'num' }, 42] }, { num: 43 }, false],
  [{ le: [{ ref: 'num' }, 42] }, { num: 42 }, true],
  [{ le: [{ ref: 'num' }, 42] }, { num: 41 }, true],
  [{ le: [{ ref: 'str' }, 'a'] }, { str: 'b' }, false],
  [{ le: [{ ref: 'str' }, 'a'] }, { str: 'a' }, true],
  [{ le: [{ ref: 'str' }, 'b'] }, { str: 'a' }, true],
  [{ le: [{ or: [2, 0] }, { and: [1, 1] }] }, {}, false],

  [{ substring: [{ ref: 'str' }, 4, 7] }, { str: 'hello world' }, 'hello world'.substring(4, 7)],
  [{ substring: [{ ref: 'str' }, 4] }, { str: 'hello world' }, 'hello world'.substring(4)],
  [{ substring: [{ ref: 'str' }, 4, 4] }, { str: 'hello world' }, 'hello world'.substring(4, 4)],
  [{ substring: [{ ref: 'str' }, 7, 4] }, { str: 'hello world' }, 'hello world'.substring(7, 4)],
  [{ substring: [{ ref: 'str' }, -1, 100] }, { str: 'hello world' }, 'hello world'.substring(-1, 100)],
  [{ substring: [{ ref: 'invalid' }, 4, 7] }, { invalid: {} }, new TypeError('Variable is not a string')],
  [{ substring: [{ ref: 'str' }, 4, 7] }, { str: String('hello world') }, 'hello world'.substring(4, 7)],
  // eslint-disable-next-line no-new-wrappers
  [{ substring: [{ ref: 'str' }, 4, 7] }, { str: new String('hello world') }, 'hello world'.substring(4, 7)],
  [
    { substring: [{ ref: 'str' }, 4, 7] },
    { str: overloadMethod(new String('hello world'), 'substring') }, // eslint-disable-line no-new-wrappers
    'hello world'.substring(4, 7)
  ],

  [{ any: [{ ref: 'arr' }, { isEmpty: { ref: '@it' } }] }, { arr: ['foo', 'bar', ''] }, true],
  [{ any: [{ ref: 'arr' }, { isEmpty: { ref: '@it' } }] }, { arr: ['foo', 'bar', 'baz'] }, false],
  [{ any: [{ ref: 'obj' }, { isEmpty: { ref: '@value' } }] }, { obj: { 0: 'foo', 1: 'bar', 2: '' } }, true],
  [{ any: [{ ref: 'obj' }, { isEmpty: { ref: '@value' } }] }, { obj: { 0: 'foo', 1: 'bar', 2: 'baz' } }, false],
  [{ any: [{ ref: 'obj' }, { isEmpty: { ref: '@key' } }] }, { obj: { foo: 0, bar: 1, '': 2 } }, true],
  [{ any: [{ ref: 'obj' }, { isEmpty: { ref: '@key' } }] }, { obj: { foo: 0, bar: 1, baz: 2 } }, false],

  [{ all: [{ ref: 'arr' }, { isEmpty: { ref: '@it' } }] }, { arr: ['foo', ''] }, false],
  [{ all: [{ ref: 'arr' }, { isEmpty: { ref: '@it' } }] }, { arr: ['', ''] }, true],
  [{ all: [{ ref: 'obj' }, { isEmpty: { ref: '@value' } }] }, { obj: { 0: 'foo', 1: '' } }, false],
  [{ all: [{ ref: 'obj' }, { isEmpty: { ref: '@value' } }] }, { obj: { 0: '', 1: '' } }, true],
  [{ all: [{ ref: 'obj' }, { isEmpty: { ref: '@key' } }] }, { obj: { foo: 0 } }, false],
  [{ all: [{ ref: 'obj' }, { isEmpty: { ref: '@key' } }] }, { obj: { '': 0 } }, true],

  [{ startsWith: [{ ref: 'str' }, 'hello'] }, { str: 'hello world!' }, true],
  [{ startsWith: [{ ref: 'str' }, 'world'] }, { str: 'hello world!' }, false],
  [{ startsWith: [{ ref: 'str' }, { ref: 'prefix' }] }, { str: 'hello world!', prefix: 'hello' }, true],
  [{ startsWith: [{ getmember: [{ ref: 'obj' }, 'str'] }, 'hello'] }, { obj: { str: 'hello world!' } }, true],
  [{ startsWith: [{ ref: 'str' }, 'hello'] }, { str: String('hello world!') }, true],
  [{ startsWith: [{ ref: 'str' }, 'world'] }, { str: String('hello world!') }, false],
  // eslint-disable-next-line no-new-wrappers
  [{ startsWith: [{ ref: 'str' }, 'hello'] }, { str: new String('hello world!') }, true],
  // eslint-disable-next-line no-new-wrappers
  [{ startsWith: [{ ref: 'str' }, 'world'] }, { str: new String('hello world!') }, false],
  // eslint-disable-next-line no-new-wrappers
  [{ startsWith: [{ ref: 'str' }, 'hello'] }, { str: overloadMethod(new String('hello world!'), 'startsWith') }, true],

  [{ endsWith: [{ ref: 'str' }, 'hello'] }, { str: 'hello world!' }, false],
  [{ endsWith: [{ ref: 'str' }, 'world!'] }, { str: 'hello world!' }, true],
  [{ endsWith: [{ ref: 'str' }, { ref: 'suffix' }] }, { str: 'hello world!', suffix: 'world!' }, true],
  [{ endsWith: [{ getmember: [{ ref: 'obj' }, 'str'] }, 'world!'] }, { obj: { str: 'hello world!' } }, true],
  [{ endsWith: [{ ref: 'str' }, 'hello'] }, { str: String('hello world!') }, false],
  [{ endsWith: [{ ref: 'str' }, 'world!'] }, { str: String('hello world!') }, true],
  // eslint-disable-next-line no-new-wrappers
  [{ endsWith: [{ ref: 'str' }, 'hello'] }, { str: new String('hello world!') }, false],
  // eslint-disable-next-line no-new-wrappers
  [{ endsWith: [{ ref: 'str' }, 'world!'] }, { str: new String('hello world!') }, true],
  // eslint-disable-next-line no-new-wrappers
  [{ endsWith: [{ ref: 'str' }, 'world!'] }, { str: overloadMethod(new String('hello world!'), 'endsWith') }, true],

  [{ filter: [{ ref: 'arr' }, { not: { isEmpty: { ref: '@it' } } }] }, { arr: ['foo', 'bar', ''] }, ['foo', 'bar']],
  [{ filter: [{ ref: 'tarr' }, { gt: [{ ref: '@it' }, 15] }] }, { tarr: new Int16Array([10, 20, 30]) }, [20, 30]],
  [
    { filter: [{ ref: 'set' }, { not: { isEmpty: { ref: '@it' } } }] },
    { set: new Set(['foo', 'bar', '']) },
    ['foo', 'bar']
  ],
  [
    { filter: [{ ref: 'obj' }, { not: { isEmpty: { ref: '@value' } } }] },
    { obj: { 1: 'foo', 2: 'bar', 3: '' } },
    { 1: 'foo', 2: 'bar' }
  ],
  [
    { filter: [{ ref: 'obj' }, { not: { isEmpty: { ref: '@key' } } }] },
    { obj: { foo: 1, bar: 2, '': 3 } },
    { foo: 1, bar: 2 }
  ],

  [{ contains: [{ ref: 'str' }, 'world'] }, { str: 'hello world' }, true],
  [{ contains: [{ ref: 'str' }, 'missing'] }, { str: 'hello world' }, false],
  [{ contains: [{ ref: 'str' }, 'world'] }, { str: String('hello world') }, true],
  [{ contains: [{ ref: 'str' }, 'missing'] }, { str: String('hello world') }, false],
  // eslint-disable-next-line no-new-wrappers
  [{ contains: [{ ref: 'str' }, 'world'] }, { str: new String('hello world') }, true],
  // eslint-disable-next-line no-new-wrappers
  [{ contains: [{ ref: 'str' }, 'missing'] }, { str: new String('hello world') }, false],
  // eslint-disable-next-line no-new-wrappers
  [{ contains: [{ ref: 'str' }, 'world'] }, { str: overloadMethod(new String('hello world'), 'includes') }, true],
  [{ contains: [{ ref: 'arr' }, 'foo'] }, { arr: ['foo', 'bar'] }, true],
  [{ contains: [{ ref: 'arr' }, 'missing'] }, { arr: ['foo', 'bar'] }, false],
  [{ contains: [{ ref: 'arr' }, 'foo'] }, { arr: overloadMethod(['foo', 'bar'], 'includes') }, true],
  [{ contains: [{ ref: 'tarr' }, 10] }, { tarr: new Int16Array([10, 20]) }, true],
  [{ contains: [{ ref: 'tarr' }, 30] }, { tarr: new Int16Array([10, 20]) }, false],
  [{ contains: [{ ref: 'tarr' }, 10] }, { tarr: overloadMethod(new Int16Array([10, 20]), 'includes') }, true],
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
    new TypeError('Variable does not support contains')
  ],
  [
    { contains: [{ ref: 'obj' }, 'missing'] },
    { obj: { foo: 'bar' } },
    new TypeError('Variable does not support contains')
  ],

  [{ matches: [{ ref: 'foo' }, '[0-9]+'] }, { foo: '42' }, true],
  [{ matches: [{ ref: 'foo' }, '[0-9]+'] }, { foo: String('42') }, true],
  // eslint-disable-next-line no-new-wrappers
  [{ matches: [{ ref: 'foo' }, '[0-9]+'] }, { foo: new String('42') }, true],
  // eslint-disable-next-line no-new-wrappers
  [{ matches: [{ ref: 'foo' }, '[0-9]+'] }, { foo: overloadMethod(new String('42'), 'match') }, true],
  [{ matches: [{ ref: 'foo' }, '[0-9]+'] }, { foo: {} }, new TypeError('Variable is not a string')],
  [{ matches: [{ ref: 'foo' }, { ref: 'regex' }] }, { foo: '42', regex: /[0-9]+/ }, true],
  [{ matches: [{ ref: 'foo' }, { ref: 'regex' }] }, { foo: '42', regex: overloadMethod(/[0-9]+/, 'test') }, true],
  [{ matches: [{ ref: 'foo' }, { ref: 'regex' }] }, { foo: '42', regex: String('[0-9]+') }, true],
  // eslint-disable-next-line no-new-wrappers
  [{ matches: [{ ref: 'foo' }, { ref: 'regex' }] }, { foo: '42', regex: new String('[0-9]+') }, true],
  [
    { matches: [{ ref: 'foo' }, { ref: 'regex' }] },
    { foo: '42', regex: overloadMethod(new String('[0-9]+'), 'match') }, // eslint-disable-line no-new-wrappers
    true
  ],
  [
    { matches: [{ ref: 'foo' }, { ref: 'regex' }] },
    { foo: '42', regex: overloadMethod({}, Symbol.match) },
    new TypeError('Regular expression must be either a string or an instance of RegExp')
  ],
  [{ matches: [{ ref: 'foo' }, { ref: 'regex' }] }, { foo: '42', regex: overloadMethod(/[0-9]+/, Symbol.match) }, true],

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

  [{ instanceof: [{ ref: 'bar' }, 'Object'] }, { bar: {} }, true],
  [{ instanceof: [{ ref: 'bar' }, 'Error'] }, { bar: new Error() }, true],
  [{ instanceof: [{ ref: 'bar' }, 'CustomObject'] }, { bar: new CustomObject(), CustomObject }, true],
  [{ instanceof: [{ ref: 'bar' }, 'SideEffectObject'] }, { bar: new SideEffectObject(), SideEffectObject }, true],

  // Proxies
  [
    { eq: [{ getmember: [{ ref: 'proxy' }, 'foo'] }, 'bar'] },
    { proxy: new Proxy({}, { get (_, p) { if (p === 'foo') throw new Error('This should never throw!') } }) },
    new Error('Possibility of side effect')
  ]
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
      .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
      .join('; ')

    it(`${JSON.stringify(ast)} + "${code}" = ${expected}`, function () {
      const fn = new Function(...Object.keys(data), `return ${compile(ast)}`) // eslint-disable-line no-new-func
      const args = Object.values(data)
      if (expected instanceof Error) {
        expect(() => fn(...args)).to.throw(expected.constructor, expected.message)
      } else {
        const result = runWithDebug(fn, args)
        if (typeof expected === 'object') {
          expect(result).to.deep.equal(expected)
        } else {
          expect(result).to.equal(expected)
        }
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
      expect(result).to.equal(expected)
    })
  }

  it('should abort if isProxy is not available on the global scope', function () {
    process[Symbol.for('datadog:isProxy')] = undefined
    const ast = { getmember: [{ ref: 'proxy' }, 'foo'] }
    const fn = new Function('proxy', `return ${compile(ast)}`) // eslint-disable-line no-new-func
    expect(fn).to.throw(Error, 'Possibility of side effect')
  })
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

function overloadPropertyWithGetter (obj, propName) {
  Object.defineProperty(obj, propName, {
    get () { throw new Error('This should never throw!') }
  })
  return obj
}

function overloadMethod (obj, methodName) {
  obj[methodName] = () => { throw new Error('This should never throw!') }
  return obj
}
