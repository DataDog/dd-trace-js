'use strict'

function getPrimitives (a1 = 1, a2 = 2) {
  // eslint-disable-next-line no-unused-vars
  const { undef, nil, bool, num, bigint, str, sym } = get().primitives
  return 'my return value'
}

function getComplextTypes (a1 = 1, a2 = 2) {
  // eslint-disable-next-line no-unused-vars, max-len
  const { oblit, obnew, arr, regex, date, map, set, wmap, wset, gen, err, fn, bfn, afn, cls, acls, prox, custProx, pPen, pRes, pRej, tarr, ab, sab, circular, hidden } = get().complexTypes
  return 'my return value'
}

function getNestedObj (a1 = 1, a2 = 2) {
  // eslint-disable-next-line no-unused-vars
  const { myNestedObj } = get().nested
  return 'my return value'
}

// WARNING: Breakpoints present above this line - Any changes to the lines above might influence tests!

// References to objects used in WeakMap/WeakSet objects to ensure that they are not garbage collected during testing
const ref = {
  wmo1: { a: 1 },
  wmo2: { b: 3 },
  wso1: { a: 1 },
  wso2: { a: 2 },
  wso3: { a: 3 }
}

// warp it all in a single function to avoid spamming the closure scope with a lot of variables (makes testing simpler)
function get () {
  const bigint = BigInt(Number.MAX_SAFE_INTEGER) * 2n

  let e, g
  const oblit = {
    a: 1,
    'b.b': 2,
    [Symbol('c')]: 3,
    // Has no side-effect
    // TODO: At some point it would be great to detect this and get the value,
    // though currently we can neither detect it, nor execute the getter.
    get d () {
      return 4
    },
    // Has side-effect: We should never try to fetch this!
    get e () {
      e = Math.random()
      return e
    },
    // Only setter
    set f (v) {}, // eslint-disable-line accessor-pairs
    // Both getter and setter
    get g () { return g },
    set g (x) { g = x }
  }

  function fnWithProperties (a, b) {}
  fnWithProperties.foo = { bar: 42 }

  class MyClass {
    #secret = 42
    constructor () {
      this.foo = this.#secret
    }
  }

  function * makeIterator () {
    yield 1
    yield 2
  }
  const gen = makeIterator()
  gen.foo = 42

  class CustomError extends Error {
    constructor (...args) {
      super(...args)
      this.foo = 42
    }
  }
  const err = new CustomError('boom!')

  const buf1 = Buffer.from('IBM')
  const buf2 = Buffer.from('hello\x01\x02\x03world')

  const arrayBuffer = new ArrayBuffer(buf1.length)
  const sharedArrayBuffer = new SharedArrayBuffer(buf2.length)

  const typedArray = new Int8Array(arrayBuffer)
  for (let i = 0; i < buf1.length; i++) typedArray[i] = buf1[i] - 1

  const sharedTypedArray = new Int8Array(sharedArrayBuffer)
  for (let i = 0; i < buf2.length; i++) sharedTypedArray[i] = buf2[i]

  const result = {
    primitives: {
      undef: undefined,
      nil: null,
      bool: true,
      num: 42,
      bigint,
      str: 'foo',
      sym: Symbol('foo')
    },
    complexTypes: {
      oblit,
      obnew: new MyClass(),
      arr: [1, 2, 3],
      regex: /foo/,
      date: new Date('2024-09-20T07:22:59.998Z'),
      map: new Map([[1, 2], [3, 4]]),
      set: new Set([[1, 2], 3, 4]),
      wmap: new WeakMap([[ref.wmo1, 2], [ref.wmo2, 4]]),
      wset: new WeakSet([ref.wso1, ref.wso2, ref.wso3]),
      gen,
      err,
      fn: fnWithProperties,
      bfn: fnWithProperties.bind(new MyClass(), 1, 2),
      afn: () => { return 42 },
      cls: MyClass,
      acls: class
            {}, // eslint-disable-line indent, brace-style
      prox: new Proxy({ target: true }, { get () { return false } }),
      custProx: new Proxy(new MyClass(), { get () { return false } }),
      pPen: new Promise(() => {}),
      pRes: Promise.resolve('resolved value'),
      pRej: Promise.reject('rejected value'), // eslint-disable-line prefer-promise-reject-errors
      tarr: typedArray, // TODO: Should we test other TypedArray's?
      ab: arrayBuffer,
      sab: sharedArrayBuffer
    },
    nested: {
      myNestedObj: {
        deepObj: { foo: { foo: { foo: { foo: { foo: true } } } } },
        deepArr: [[[[[42]]]]]
      }
    }
  }

  result.complexTypes.circular = result.complexTypes

  Object.defineProperty(result.complexTypes, 'hidden', {
    value: 'secret',
    enumerable: false
  })

  // ensure we don't get an unhandled promise rejection error
  result.complexTypes.pRej.catch(() => {})

  return result
}

module.exports = {
  getPrimitives,
  getComplextTypes,
  getNestedObj
}
