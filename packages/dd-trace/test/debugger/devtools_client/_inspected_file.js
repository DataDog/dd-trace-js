'use strict'

function getPrimitives (myArg1 = 1, myArg2 = 2) {
  // eslint-disable-next-line no-unused-vars
  const { myUndef, myNull, myBool, myNumber, myBigInt, myString, mySym } = primitives
  return 'my return value'
}

function getComplextTypes (myArg1 = 1, myArg2 = 2) {
  // eslint-disable-next-line no-unused-vars
  const { myRegex, myMap, mySet, myArr, myObj, myFunc, myArrowFunc, myInstance, MyClass, circular } = customObj
  return 'my return value'
}

function getNestedObj (myArg1 = 1, myArg2 = 2) {
  // eslint-disable-next-line no-unused-vars
  const { myNestedObj } = nested
  return 'my return value'
}

class MyClass {
  constructor () {
    this.foo = 42
  }
}

const primitives = {
  myUndef: undefined,
  myNull: null,
  myBool: true,
  myNumber: 42,
  myBigInt: 42n,
  myString: 'foo',
  mySym: Symbol('foo')
}

const customObj = {
  myRegex: /foo/,
  myMap: new Map([[1, 2], [3, 4]]),
  mySet: new Set([1, 2, 3]),
  myArr: [1, 2, 3],
  myObj: { a: 1, b: 2, c: 3 },
  myFunc () { return 42 },
  myArrowFunc: () => { return 42 },
  myInstance: new MyClass(),
  MyClass
}

customObj.circular = customObj

const nested = {
  myNestedObj: {
    deepObj: { foo: { foo: { foo: { foo: { foo: true } } } } },
    deepArr: [[[[[42]]]]]
  }
}

module.exports = {
  getPrimitives,
  getComplextTypes,
  getNestedObj
}
