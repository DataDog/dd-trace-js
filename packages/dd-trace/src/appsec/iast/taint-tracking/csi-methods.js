'use strict'

const csiMethods = [
  { src: 'plusOperator', operator: true },
  { src: 'concat' },
  { src: 'replace' },
  { src: 'slice' },
  { src: 'substr' },
  { src: 'substring' },
  { src: 'trim' },
  { src: 'trimEnd' },
  { src: 'trimStart', dst: 'trim' }
]

function getExpectedMethods () {
  const set = new Set()
  for (const definition of csiMethods) {
    if (definition.dst) {
      set.add(definition.dst)
    } else {
      set.add(definition.src)
    }
  }
  return [...set]
}

module.exports = {
  csiMethods,
  getExpectedMethods
}
