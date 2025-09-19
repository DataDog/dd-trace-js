'use strict'

/**
 * AST node types and test case shapes for devtools condition expressions.
 * These typedefs intentionally avoid the `any` type and aim to be as precise as practical.
 *
 * @typedef {{ ref: string }} RefExpression
 * @typedef {{ getmember: [Expression, string|RefExpression] }} GetMemberExpression
 * @typedef {{ index: [Expression, number|string|RefExpression] }} IndexExpression
 * @typedef {{ len: Expression }} LenExpression
 * @typedef {{ count: Expression }} CountExpression
 * @typedef {{ isEmpty: Expression }} IsEmptyExpression
 * @typedef {{ eq: [Expression, Expression] }} EqExpression
 * @typedef {{ ne: [Expression, Expression] }} NeExpression
 * @typedef {{ gt: [Expression, Expression] }} GtExpression
 * @typedef {{ ge: [Expression, Expression] }} GeExpression
 * @typedef {{ lt: [Expression, Expression] }} LtExpression
 * @typedef {{ le: [Expression, Expression] }} LeExpression
 * @typedef {{ substring: [Expression, number, (number|undefined)?] }} SubstringExpression
 * @typedef {{ startsWith: [Expression, string|RefExpression] }} StartsWithExpression
 * @typedef {{ endsWith: [Expression, string|RefExpression] }} EndsWithExpression
 * @typedef {{ any: [Expression, Expression] }} AnyExpression
 * @typedef {{ all: [Expression, Expression] }} AllExpression
 * @typedef {{ or: [Expression, Expression] }} OrExpression
 * @typedef {{ and: [Expression, Expression] }} AndExpression
 * @typedef {{ filter: [Expression, Expression] }} FilterExpression
 * @typedef {{ not: Expression }} NotExpression
 * @typedef {{ contains: [Expression, Expression] }} ContainsExpression
 * @typedef {{ matches: [Expression, string|Expression] }} MatchesExpression
 * @typedef {{ instanceof: [Expression, string] }} InstanceofExpression
 * @typedef {{ isDefined: Expression }} IsDefinedExpression
 *
 * @typedef {null|boolean|number|string|bigint} Literal
 *
 * @typedef {Literal|
 *   RefExpression|
 *   GetMemberExpression|
 *   IndexExpression|
 *   LenExpression|
 *   CountExpression|
 *   IsEmptyExpression|
 *   EqExpression|
 *   NeExpression|
 *   GtExpression|
 *   GeExpression|
 *   LtExpression|
 *   LeExpression|
 *   SubstringExpression|
 *   StartsWithExpression|
 *   EndsWithExpression|
 *   AnyExpression|
 *   AllExpression|
 *   OrExpression|
 *   AndExpression|
 *   FilterExpression|
 *   NotExpression|
 *   ContainsExpression|
 *   MatchesExpression|
 *   InstanceofExpression|
 *   IsDefinedExpression} Expression
 *
 * @typedef {Object.<string, unknown>} VariableBindings
 *
 * @typedef {[Expression, VariableBindings, unknown]} TestCaseTuple
 * @typedef {{
 *   ast: Expression,
 *   vars?: VariableBindings,
 *   expected?: unknown,
 *   execute?: boolean,
 *   before?: () => void,
 *   suffix?: string
 * }} TestCaseObject
 * @typedef {TestCaseTuple|TestCaseObject} TestCase
 */

class CustomObject {}
class HasInstanceSideEffect {
  static [Symbol.hasInstance] () { throw new Error('This should never throw!') }
}
const weakKey = { weak: 'key' }
const objectWithToPrimitiveSymbol = Object.create(Object.prototype, {
  [Symbol.toPrimitive]: { value: () => { throw new Error('This should never throw!') } }
})
class EvilRegex extends RegExp {
  /**
   * @override
   * @param {string} string
   * @returns {RegExpExecArray | null}
   */
  exec (string) { throw new Error('This should never throw!') }
}

/** @type {TestCase[]} */
const literals = [
  [null, {}, null],
  [42, {}, 42],
  [true, {}, true],
  ['foo', {}, 'foo']
]

/** @type {TestCase[]} */
const references = [
  [{ ref: 'foo' }, { foo: 42 }, 42],
  [{ ref: 'foo' }, {}, new ReferenceError('foo is not defined')],

  // Reserved words, but we allow them as they can be useful
  [{ ref: 'this' }, {}, global], // Unless bound, `this` defaults to the global object
  { ast: { ref: 'super' }, expected: 'super', execute: false },

  // Litterals, but we allow them as they can be useful
  [{ ref: 'undefined' }, {}, undefined],
  [{ ref: 'Infinity' }, {}, Infinity],

  // Old standard reserved words, no need to disallow them
  [{ ref: 'abstract' }, { abstract: 42 }, 42],

  // Input sanitization
  {
    ast: { ref: 'break' },
    vars: { foo: { bar: 42 } },
    expected: new SyntaxError('Illegal identifier: break'),
    execute: false
  },
  {
    ast: { ref: 'let' },
    vars: { foo: { bar: 42 } },
    expected: new SyntaxError('Illegal identifier: let'),
    execute: false
  },
  {
    ast: { ref: 'await' },
    vars: { foo: { bar: 42 } },
    expected: new SyntaxError('Illegal identifier: await'),
    execute: false
  },
  {
    ast: { ref: 'enum' },
    vars: { foo: { bar: 42 } },
    expected: new SyntaxError('Illegal identifier: enum'),
    execute: false
  },
  {
    ast: { ref: 'implements' },
    vars: { foo: { bar: 42 } },
    expected: new SyntaxError('Illegal identifier: implements'),
    execute: false
  },
  { ast: { ref: 'NaN' }, expected: new SyntaxError('Illegal identifier: NaN'), execute: false },
  {
    ast: { ref: 'foo.bar' },
    vars: { foo: { bar: 42 } },
    expected: new SyntaxError('Illegal identifier: foo.bar'),
    execute: false
  },
  {
    ast: { ref: 'foo()' },
    vars: { foo: () => {} },
    expected: new SyntaxError('Illegal identifier: foo()'),
    execute: false
  },
  {
    ast: { ref: 'foo; bar' },
    vars: { foo: 1, bar: 2 },
    expected: new SyntaxError('Illegal identifier: foo; bar'),
    execute: false
  },
  {
    ast: { ref: 'foo\nbar' },
    vars: { foo: 1, bar: 2 },
    expected: new SyntaxError('Illegal identifier: foo\nbar'),
    execute: false
  },
  {
    ast: { ref: 'throw new Error()' },
    expected: new SyntaxError('Illegal identifier: throw new Error()'),
    execute: false
  }
]

/** @type {TestCase[]} */
const propertyAccess = [
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
    new Error('Accessing a Map is not allowed')
  ],
  [
    { getmember: [{ ref: 'wmap' }, { ref: 'key' }] },
    { key: weakKey, wmap: new WeakMap([[weakKey, 'bar']]) },
    new Error('Accessing a WeakMap is not allowed')
  ],
  [
    { getmember: [{ ref: 'obj' }, 'getter'] },
    { obj: Object.create(Object.prototype, { getter: { get () { return 'x' } } }) },
    new Error('Possibility of side effect')
  ],
  {
    before: () => { process[Symbol.for('datadog:node:util:types')] = undefined },
    ast: { getmember: [{ ref: 'proxy' }, 'foo'] },
    vars: { proxy: {} },
    expected: new Error('Possibility of side effect')
  },

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
  ]
]

/** @type {TestCase[]} */
const sizes = [
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
    new TypeError('Cannot get size of WeakSet or WeakMap')
  ],
  [
    { len: { ref: 'wmap' } },
    { wmap: new WeakMap([[weakKey, 2]]) },
    new TypeError('Cannot get size of WeakSet or WeakMap')
  ],
  [{ len: { getmember: [{ ref: 'obj' }, 'arr'] } }, { obj: { arr: Array(10).fill(0) } }, 10],
  [{ len: { getmember: [{ ref: 'obj' }, 'tarr'] } }, { obj: { tarr: new Int16Array([10, 20, 30]) } }, 3],
  [
    { len: { getmember: [{ ref: 'obj' }, 'tarr'] } },
    { obj: { tarr: overloadPropertyWithGetter(new Int16Array([10, 20, 30]), 'length') } },
    new Error('Possibility of side effect')
  ],
  [{ len: { ref: 'pojo' } }, { pojo: { a: 1, b: 2, c: 3 } }, 3],
  [
    { len: { getmember: [{ ref: 'obj' }, 'unknownProp'] } },
    { obj: {} },
    new TypeError('Cannot get length of variable')
  ],
  [{ len: { ref: 'invalid' } }, {}, new ReferenceError('invalid is not defined')],

  // `count` should be implemented as a synonym for `len`, so we shouldn't need to test it as thoroughly
  [{ count: { ref: 'str' } }, { str: 'hello' }, 5],
  [{ count: { ref: 'arr' } }, { arr: [1, 2, 3] }, 3],

  [{ isEmpty: { ref: 'str' } }, { str: '' }, true],
  [{ isEmpty: { ref: 'str' } }, { str: 'hello' }, false],
  [{ isEmpty: { ref: 'str' } }, { str: String('') }, true],
  [{ isEmpty: { ref: 'str' } }, { str: String('hello') }, false],
  [{ isEmpty: { ref: 'str' } }, { str: new String('') }, true], // eslint-disable-line no-new-wrappers
  [{ isEmpty: { ref: 'str' } }, { str: new String('hello') }, false], // eslint-disable-line no-new-wrappers
  [{ isEmpty: { ref: 'arr' } }, { arr: [] }, true],
  [{ isEmpty: { ref: 'arr' } }, { arr: [1, 2, 3] }, false],
  [{ isEmpty: { ref: 'tarr' } }, { tarr: new Int32Array(0) }, true],
  [{ isEmpty: { ref: 'tarr' } }, { tarr: new Int32Array([1, 2, 3]) }, false],
  [{ isEmpty: { ref: 'set' } }, { set: new Set() }, true],
  [{ isEmpty: { ref: 'set' } }, { set: new Set([1, 2, 3]) }, false],
  [{ isEmpty: { ref: 'map' } }, { map: new Map() }, true],
  [{ isEmpty: { ref: 'map' } }, { map: new Map([['a', 1], ['b', 2]]) }, false],
  [
    { isEmpty: { ref: 'obj' } },
    { obj: new WeakSet() },
    new TypeError('Cannot get size of WeakSet or WeakMap')
  ]
]

/** @type {TestCase[]} */
const equality = [
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
  [{ eq: [{ ref: 'nan' }, { ref: 'nan' }] }, { nan: NaN }, false],
  [{ eq: [{ getmember: [{ ref: 'obj' }, 'foo'] }, { ref: 'undefined' }] }, { obj: { foo: undefined } }, true],
  [{ eq: [{ getmember: [{ ref: 'obj' }, 'foo'] }, { ref: 'undefined' }] }, { obj: {} }, true],
  [{ eq: [{ getmember: [{ ref: 'obj' }, 'foo'] }, { ref: 'undefined' }] }, { obj: { foo: null } }, false],
  [{ eq: [{ or: [true, false] }, { and: [true, false] }] }, {}, false],
  [
    { eq: [{ getmember: [{ ref: 'proxy' }, 'foo'] }, 'bar'] },
    { proxy: new Proxy({}, { get (_, p) { if (p === 'foo') throw new Error('This should never throw!') } }) },
    new Error('Possibility of side effect')
  ],

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
  { ast: { gt: [1, 2] }, expected: '1 > 2', execute: false },
  [
    { gt: [{ ref: 'obj' }, 5] },
    { obj: objectWithToPrimitiveSymbol },
    new Error('Possibility of side effect due to coercion method')
  ],
  [
    { gt: [5, { ref: 'obj' }] },
    { obj: objectWithToPrimitiveSymbol },
    new Error('Possibility of side effect due to coercion method')
  ],
  [
    { gt: [{ ref: 'obj' }, 5] },
    { obj: { valueOf () { throw new Error('This should never throw!') } } },
    new Error('Possibility of side effect due to coercion method')
  ],
  [
    { gt: [5, { ref: 'obj' }] },
    { obj: { valueOf () { throw new Error('This should never throw!') } } },
    new Error('Possibility of side effect due to coercion method')
  ],
  [
    { gt: [{ ref: 'obj' }, 5] },
    { obj: { toString () { throw new Error('This should never throw!') } } },
    new Error('Possibility of side effect due to coercion method')
  ],
  [
    { gt: [5, { ref: 'obj' }] },
    { obj: { toString () { throw new Error('This should never throw!') } } },
    new Error('Possibility of side effect due to coercion method')
  ],
  [
    { gt: [{ ref: 'obj' }, 5] },
    { obj: new Proxy({}, { get (_, p) { if (p === 'valueOf') throw new Error('This should never throw!') } }) },
    new Error('Possibility of side effect')
  ],
  [
    { gt: [5, { ref: 'obj' }] },
    { obj: new Proxy({}, { get (_, p) { if (p === 'valueOf') throw new Error('This should never throw!') } }) },
    new Error('Possibility of side effect')
  ],

  [{ ge: [{ ref: 'num' }, 42] }, { num: 43 }, true],
  [{ ge: [{ ref: 'num' }, 42] }, { num: 42 }, true],
  [{ ge: [{ ref: 'num' }, 42] }, { num: 41 }, false],
  [{ ge: [{ ref: 'str' }, 'a'] }, { str: 'b' }, true],
  [{ ge: [{ ref: 'str' }, 'a'] }, { str: 'a' }, true],
  [{ ge: [{ ref: 'str' }, 'b'] }, { str: 'a' }, false],
  [{ ge: [{ or: [1, 0] }, { and: [1, 2] }] }, {}, false],
  { ast: { ge: [1, 2] }, expected: '1 >= 2', execute: false },
  [
    { ge: [{ ref: 'obj' }, 5] },
    { obj: objectWithToPrimitiveSymbol },
    new Error('Possibility of side effect due to coercion method')
  ],
  [
    { ge: [{ ref: 'obj' }, 5] },
    { obj: { valueOf () { throw new Error('This should never throw!') } } },
    new Error('Possibility of side effect due to coercion method')
  ],
  [
    { ge: [{ ref: 'obj' }, 5] },
    { obj: { toString () { throw new Error('This should never throw!') } } },
    new Error('Possibility of side effect due to coercion method')
  ],

  [{ lt: [{ ref: 'num' }, 42] }, { num: 43 }, false],
  [{ lt: [{ ref: 'num' }, 42] }, { num: 42 }, false],
  [{ lt: [{ ref: 'num' }, 42] }, { num: 41 }, true],
  [{ lt: [{ ref: 'str' }, 'a'] }, { str: 'b' }, false],
  [{ lt: [{ ref: 'str' }, 'a'] }, { str: 'a' }, false],
  [{ lt: [{ ref: 'str' }, 'b'] }, { str: 'a' }, true],
  [{ lt: [{ or: [1, 0] }, { and: [1, 0] }] }, {}, false],
  { ast: { lt: [1, 2] }, expected: '1 < 2', execute: false },
  [
    { lt: [{ ref: 'obj' }, 5] },
    { obj: objectWithToPrimitiveSymbol },
    new Error('Possibility of side effect due to coercion method')
  ],
  [
    { lt: [{ ref: 'obj' }, 5] },
    { obj: { valueOf () { throw new Error('This should never throw!') } } },
    new Error('Possibility of side effect due to coercion method')
  ],
  [
    { lt: [{ ref: 'obj' }, 5] },
    { obj: { toString () { throw new Error('This should never throw!') } } },
    new Error('Possibility of side effect due to coercion method')
  ],

  [{ le: [{ ref: 'num' }, 42] }, { num: 43 }, false],
  [{ le: [{ ref: 'num' }, 42] }, { num: 42 }, true],
  [{ le: [{ ref: 'num' }, 42] }, { num: 41 }, true],
  [{ le: [{ ref: 'str' }, 'a'] }, { str: 'b' }, false],
  [{ le: [{ ref: 'str' }, 'a'] }, { str: 'a' }, true],
  [{ le: [{ ref: 'str' }, 'b'] }, { str: 'a' }, true],
  [{ le: [{ or: [2, 0] }, { and: [1, 1] }] }, {}, false],
  { ast: { le: [1, 2] }, expected: '1 <= 2', execute: false },
  [
    { le: [{ ref: 'obj' }, 5] },
    { obj: objectWithToPrimitiveSymbol },
    new Error('Possibility of side effect due to coercion method')
  ],
  [
    { le: [{ ref: 'obj' }, 5] },
    { obj: { valueOf () { throw new Error('This should never throw!') } } },
    new Error('Possibility of side effect due to coercion method')
  ],
  [
    { le: [{ ref: 'obj' }, 5] },
    { obj: { toString () { throw new Error('This should never throw!') } } },
    new Error('Possibility of side effect due to coercion method')
  ]
]

/** @type {TestCase[]} */
const stringManipulation = [
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
  [
    { substring: [{ ref: 'str' }, 4, 7] },
    { str: new (createClassWithOverloadedMethodInPrototypeChain(String, 'substring'))('hello world') },
    'hello world'.substring(4, 7)
  ]
]

/** @type {TestCase[]} */
const stringComparison = [
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
  [
    { startsWith: [{ ref: 'str' }, 'hello'] },
    { str: Object.create({ startsWith () { throw new Error('This should never throw!') } }) },
    new TypeError('Variable is not a string')
  ],
  [
    { startsWith: ['hello world!', { ref: 'str' }] },
    { str: { toString () { throw new Error('This should never throw!') } } },
    new TypeError('Variable is not a string')
  ],
  [
    { startsWith: [{ ref: 'str' }, 'hello'] },
    { str: new (createClassWithOverloadedMethodInPrototypeChain(String, 'startsWith'))('hello world!') },
    true
  ],

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
  [
    { endsWith: [{ ref: 'str' }, 'hello'] },
    { str: Object.create({ endsWith () { throw new Error('This should never throw!') } }) },
    new TypeError('Variable is not a string')
  ],
  [
    { endsWith: ['hello world!', { ref: 'str' }] },
    { str: { toString () { throw new Error('This should never throw!') } } },
    new TypeError('Variable is not a string')
  ],
  [
    { endsWith: [{ ref: 'str' }, 'world!'] },
    { str: new (createClassWithOverloadedMethodInPrototypeChain(String, 'endsWith'))('hello world!') },
    true
  ]
]

/** @type {TestCase[]} */
const logicalOperators = [
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

  [{ or: [{ ref: 'bar' }, { ref: 'foo' }] }, { bar: 42 }, 42],
  [{ or: [{ ref: 'bar' }, { ref: 'foo' }] }, { bar: 0 }, new ReferenceError('foo is not defined')],

  [{ and: [{ ref: 'bar' }, { ref: 'foo' }] }, { bar: 0 }, 0],
  [{ and: [{ ref: 'bar' }, { ref: 'foo' }] }, { bar: 42 }, new ReferenceError('foo is not defined')]
]

/** @type {TestCase[]} */
const collectionOperations = [
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
  ]
]

/** @type {TestCase[]} */
const membershipAndMatching = [
  [{ contains: [{ ref: 'str' }, 'world'] }, { str: 'hello world!' }, true],
  [{ contains: [{ ref: 'str' }, 'missing'] }, { str: 'hello world!' }, false],
  [{ contains: [{ ref: 'str' }, 'world'] }, { str: String('hello world!') }, true],
  [{ contains: [{ ref: 'str' }, 'missing'] }, { str: String('hello world!') }, false],
  // eslint-disable-next-line no-new-wrappers
  [{ contains: [{ ref: 'str' }, 'world'] }, { str: new String('hello world!') }, true],
  // eslint-disable-next-line no-new-wrappers
  [{ contains: [{ ref: 'str' }, 'missing'] }, { str: new String('hello world!') }, false],
  // eslint-disable-next-line no-new-wrappers
  [{ contains: [{ ref: 'str' }, 'world'] }, { str: overloadMethod(new String('hello world!'), 'includes') }, true],
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
  [
    { contains: [{ ref: 'str' }, 'world'] },
    { str: new (createClassWithOverloadedMethodInPrototypeChain(String, 'includes'))('hello world!') },
    true
  ],
  [
    { contains: [{ ref: 'arr' }, 'foo'] },
    { arr: new (createClassWithOverloadedMethodInPrototypeChain(Array, 'includes'))('foo', 'bar') },
    true
  ],
  [
    { contains: [{ ref: 'tarr' }, 10] },
    { tarr: new (createClassWithOverloadedMethodInPrototypeChain(Int32Array, 'includes'))([10, 20]) },
    true
  ],
  [
    { contains: [{ ref: 'set' }, 'foo'] },
    { set: new (createClassWithOverloadedMethodInPrototypeChain(Set, 'has'))(['foo', 'bar']) },
    true
  ],
  [
    { contains: [{ ref: 'map' }, 'foo'] },
    { map: new (createClassWithOverloadedMethodInPrototypeChain(Map, 'has'))([['foo', 'bar']]) },
    true
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
  [
    { matches: [{ ref: 'foo' }, '[0-9]+'] },
    { foo: new (createClassWithOverloadedMethodInPrototypeChain(String, 'match'))('42') },
    true
  ],
  [
    { matches: ['42', { ref: 'regex' }] },
    { regex: new EvilRegex('[0-9]+') },
    new TypeError('Regular expression must be either a string or an instance of RegExp')
  ]
]

/** @type {TestCase[]} */
const typeAndDefinitionChecks = [
  // Primitive types
  [{ instanceof: [{ ref: 'foo' }, 'string'] }, { foo: 'foo' }, true],
  [{ instanceof: [{ ref: 'foo' }, 'number'] }, { foo: 42 }, true],
  [{ instanceof: [{ ref: 'foo' }, 'number'] }, { foo: '42' }, false],
  [{ instanceof: [{ ref: 'foo' }, 'bigint'] }, { foo: 42n }, true],
  [{ instanceof: [{ ref: 'foo' }, 'boolean'] }, { foo: false }, true],
  [{ instanceof: [{ ref: 'foo' }, 'boolean'] }, { foo: 0 }, false],
  [{ instanceof: [{ ref: 'foo' }, 'undefined'] }, { foo: undefined }, true],
  [{ instanceof: [{ ref: 'foo' }, 'symbol'] }, { foo: Symbol('foo') }, true],
  [{ instanceof: [{ ref: 'foo' }, 'null'] }, { foo: null }, false], // typeof null is 'object'

  // Objects
  [{ instanceof: [{ ref: 'bar' }, 'Object'] }, { bar: {} }, true],
  [{ instanceof: [{ ref: 'bar' }, 'Error'] }, { bar: new Error() }, true],
  [{ instanceof: [{ ref: 'bar' }, 'Error'] }, { bar: {} }, false],
  [{ instanceof: [{ ref: 'bar' }, 'CustomObject'] }, { bar: new CustomObject(), CustomObject }, true],
  [
    { instanceof: [{ ref: 'bar' }, 'HasInstanceSideEffect'] },
    { bar: new HasInstanceSideEffect(), HasInstanceSideEffect },
    true
  ],
  {
    ast: { instanceof: [{ ref: 'foo' }, 'foo.bar'] },
    expected: new SyntaxError('Illegal identifier: foo.bar'),
    execute: false
  },

  [{ isDefined: { ref: 'foo' } }, { bar: 42 }, false],
  [{ isDefined: { ref: 'bar' } }, { bar: 42 }, true],
  [{ isDefined: { ref: 'bar' } }, { bar: undefined }, true],
  { ast: { isDefined: { ref: 'foo' } }, suffix: 'const foo = undefined', expected: false },
  { ast: { isDefined: { ref: 'foo' } }, suffix: 'const foo = 42', expected: false },
  { ast: { isDefined: { ref: 'foo' } }, suffix: 'let foo', expected: false },
  { ast: { isDefined: { ref: 'foo' } }, suffix: 'let foo = undefined', expected: false },
  { ast: { isDefined: { ref: 'foo' } }, suffix: 'let foo = 42', expected: false },
  { ast: { isDefined: { ref: 'foo' } }, suffix: 'var foo', expected: true }, // var is hoisted
  { ast: { isDefined: { ref: 'foo' } }, suffix: 'var foo = undefined', expected: true }, // var is hoisted
  { ast: { isDefined: { ref: 'foo' } }, suffix: 'var foo = 42', expected: true }, // var is hoisted
  { ast: { isDefined: { ref: 'foo' } }, suffix: 'function foo () {}', expected: true }, // function is hoisted
  { ast: { isDefined: { ref: 'foo' } }, suffix: '', expected: false }
]

/**
 * Define a getter on the provided object that throws on access.
 *
 * @template T extends object
 * @param {T} obj
 * @param {string} propName
 * @returns {T}
 */
function overloadPropertyWithGetter (obj, propName) {
  Object.defineProperty(obj, propName, {
    get () { throw new Error('This should never throw!') }
  })
  return obj
}

/**
 * Overwrite a method/property on the object with a throwing function.
 *
 * @template T extends object
 * @param {T} obj
 * @param {PropertyKey} methodName
 * @returns {T}
 */
function overloadMethod (obj, methodName) {
  obj[methodName] = () => { throw new Error('This should never throw!') }
  return obj
}

/**
 * Create a subclass of the given built-in where the given property/method is overloaded
 * in the prototype chain to throw, and return a further subclass constructor.
 *
 * @overload
 * @param {StringConstructor} Builtin
 * @param {PropertyKey} propName
 * @returns {StringConstructor}
 *
 * @overload
 * @param {ArrayConstructor} Builtin
 * @param {PropertyKey} propName
 * @returns {ArrayConstructor}
 *
 * @overload
 * @param {Int16ArrayConstructor} Builtin
 * @param {PropertyKey} propName
 * @returns {Int16ArrayConstructor}
 *
 * @overload
 * @param {Int32ArrayConstructor} Builtin
 * @param {PropertyKey} propName
 * @returns {Int32ArrayConstructor}
 *
 * @overload
 * @param {SetConstructor} Builtin
 * @param {PropertyKey} propName
 * @returns {SetConstructor}
 *
 * @overload
 * @param {MapConstructor} Builtin
 * @param {PropertyKey} propName
 * @returns {MapConstructor}
 *
 * @param {new (...args: unknown[]) => object} Builtin
 * @param {PropertyKey} propName
 * @returns {new (...args: unknown[]) => object}
 */
function createClassWithOverloadedMethodInPrototypeChain (Builtin, propName) {
  class Klass extends Builtin {
    [propName] () { throw new Error('This should never throw!') }
  }

  class SubKlass extends Klass {}

  return SubKlass
}

/** @type {{
 *  literals: TestCase[],
 *  references: TestCase[],
 *  propertyAccess: TestCase[],
 *  sizes: TestCase[],
 *  equality: TestCase[],
 *  stringManipulation: TestCase[],
 *  stringComparison: TestCase[],
 *  logicalOperators: TestCase[],
 *  collectionOperations: TestCase[],
 *  membershipAndMatching: TestCase[],
 *  typeAndDefinitionChecks: TestCase[]
 * }} */
module.exports = {
  literals,
  references,
  propertyAccess,
  sizes,
  equality,
  stringManipulation,
  stringComparison,
  logicalOperators,
  collectionOperations,
  membershipAndMatching,
  typeAndDefinitionChecks
}
