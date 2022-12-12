'use strict'

const csiMethodDefinition = [
  { src: 'plusOperator', operator: true },
  { src: String.prototype.trim },
  { src: String.prototype.trimStart, dst: String.prototype.trim },
  { src: String.prototype.trimEnd }
]

function isFunction (fn) {
  return typeof fn === 'function'
}

function getCsiMethodName (def) {
  return isFunction(def) ? def.name : def
}

const prototypes = csiMethodDefinition
  .map(method => isFunction(method.src) ? method.src : null)
  .filter(proto => proto)

function isValidCsiMethod (fn) {
  return prototypes.indexOf(fn) === -1
}

const csiMethods = csiMethodDefinition.map(method => {
  const csiMethod = {
    src: getCsiMethodName(method.src)
  }
  if (method.dst) {
    csiMethod.dst = getCsiMethodName(method.dst)
  }
  if (method.operator) {
    csiMethod.operator = method.operator
  }
  return csiMethod
})

module.exports = {
  isValidCsiMethod,
  csiMethods
}
