'use strict'

const { LARGE_OBJECT_SKIP_THRESHOLD } = require('../../../../../src/debugger/devtools_client/snapshot/constants')

// `LARGE_SIZE` is larger than the default maxCollectionSize, but lower than the large object skip threshold, after
// which nothing is captured.
const LARGE_SIZE = LARGE_OBJECT_SKIP_THRESHOLD - 1

function run () {
  const arr = []
  const map = new Map()
  const set = new Set()
  const wmap = new WeakMap()
  const wset = new WeakSet()
  const typedArray = new Uint16Array(new ArrayBuffer(LARGE_SIZE * 2))

  for (let i = 1; i <= LARGE_SIZE; i++) {
    // A reference that can be used in WeakMap/WeakSet to avoid GC
    const obj = { i }

    arr.push(i)
    map.set(i, obj)
    set.add(i)
    wmap.set(obj, i)
    wset.add(obj)
    typedArray[i - 1] = i
  }

  return 'my return value' // breakpoint at this line
}

module.exports = { run }
