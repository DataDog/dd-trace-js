'use strict'

function run () {
  const arr = []
  const map = new Map()
  const set = new Set()
  const wmap = new WeakMap()
  const wset = new WeakSet()
  const typedArray = new Uint16Array(new ArrayBuffer(2000))

  // 1000 is larger the default maxCollectionSize of 100
  for (let i = 1; i <= 1000; i++) {
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
