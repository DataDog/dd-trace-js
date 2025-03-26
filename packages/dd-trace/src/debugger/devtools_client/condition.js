'use strict'

module.exports = compile

function compile (node) {
  if (node === null || typeof node === 'number' || typeof node === 'boolean' || typeof node === 'string') {
    return JSON.stringify(node)
  }

  const [type, value] = Object.entries(node)[0]

  if (type === 'not') {
    return `!(${compile(value)})`
  } else if (type === 'isEmpty') {
    return `(${compile(value)}).length === 0`
  } else if (type === 'isDefined') {
    return `(() => {
        try {
          ${value}
          return true
        } catch {
          return false
        }
      })()`
  } else if (type === 'instanceof') {
    return `${compile(value[0])} instanceof ${value[1]}`
  } else if (type === 'len' || type === 'count') {
    return `(${compile(value)}).length`
  } else if (type === 'ref') {
    if (value === '@it') {
      return 'it'
    } else if (value === '@key') {
      return 'key'
    } else if (value === '@value') {
      return 'value'
    } else {
      return value
    }
  } else if (Array.isArray(value)) {
    const args = value.map(compile)
    switch (type) {
      case 'eq': return `${args[0]} === ${args[1]}`
      case 'ne': return `${args[0]} !== ${args[1]}`
      case 'gt': return `${args[0]} > ${args[1]}`
      case 'ge': return `${args[0]} >= ${args[1]}`
      case 'lt': return `${args[0]} < ${args[1]}`
      case 'le': return `${args[0]} <= ${args[1]}`
      case 'any': return iterateOn('some', ...args)
      case 'all': return iterateOn('every', ...args)
      case 'and': return `(${args.join(') && (')})`
      case 'or': return `(${args.join(') || (')})`
      case 'startsWith': return `${args[0]}.startsWith(${args[1]})`
      case 'endsWith': return `${args[0]}.endsWith(${args[1]})`
      case 'contains': return `(() => {
          if (typeof ${args[0]} === 'string') {
            return ${args[0]}.includes(${args[1]})
          } else if (Array.isArray(${args[0]}) || ${args[0]} instanceof Object.getPrototypeOf(Int8Array)) {
            return ${callMethodOnPrototype(args[0], 'includes', args[1])}
          } else if (
            ${args[0]} instanceof Set || ${args[0]} instanceof WeakSet ||
            ${args[0]} instanceof Map || ${args[0]} instanceof WeakMap
          ) {
            return ${callMethodOnPrototype(args[0], 'has', args[1])}
          } else {
            throw new TypeError('Variable ${args[0]} does not support contains')
          }
        })()`
      case 'matches': return `(() => {
        if (typeof ${args[0]} === 'string') {
          if (${args[1]} instanceof RegExp) {
            return ${callMethodOnPrototype(args[1], 'test', args[0])}
          } else {
            return ${args[0]}.match(${args[1]}) !== null
          }
        } else {
          throw new TypeError('Variable ${args[0]} is not a string')
        }
      })()`
      case 'filter': return `${isCollection(args[0])}
        ? Array.from(${args[0]}).filter((it) => ${args[1]})
        : Object.entries(${args[0]}).filter(([key, value]) => ${args[1]}).reduce((acc, [key, value]) => {
          acc[key] = value
          return acc
        }, {})`
      case 'substring': return `${args[0]}.substring(${args[1]}, ${args[2]})`
      case 'getmember': return throwOnSideEffect(...args, false, false)
      case 'index': return throwOnSideEffect(...args, false, true)
    }
  }

  throw new TypeError(`Unknown AST node type: ${type}`)
}

function callMethodOnPrototype (variable, methodName, ...args) {
  return `Object.getPrototypeOf(${variable}).${methodName}.call(${variable}, ${args.join(', ')})`
}

function iterateOn (fnName, variable, callbackCode) {
  return `${isCollection(variable)}
    ? Array.from(${variable}).${fnName}((it) => ${callbackCode})
    : Object.entries(${variable}).${fnName}(([key, value]) => ${callbackCode})`
}

function isCollection (variable) {
  return `Array.isArray(${variable}) || ${variable} instanceof Set || ${variable} instanceof WeakSet`
}

function throwOnSideEffect (variable, keyOrIndex, allowSetAccess, allowMapAccess) {
  return `(() => {
    if (${variable} instanceof Set || ${variable} instanceof WeakSet) {
      ${allowSetAccess
        ? `return ${variable}.has(${keyOrIndex}) ? ${keyOrIndex} : undefined`
        : 'throw new Error(\'Aborting because accessing a Set or WeakSet is not allowed\')'}
    } else if (${variable} instanceof Map || ${variable} instanceof WeakMap) {
      ${allowMapAccess
        ? `return ${variable}.get(${keyOrIndex})`
        : 'throw new Error(\'Aborting because accessing a Map or WeakMap is not allowed\')'}
    } else if (Object.getOwnPropertyDescriptor(${variable}, ${keyOrIndex})?.get === undefined) {
      return ${variable}[${keyOrIndex}]
    } else {
      throw new Error('Aborting because of possible side effects')
    }
  })()`
}
