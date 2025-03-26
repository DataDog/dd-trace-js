'use strict'

module.exports = compile

// TODO: Support `new String()` all the places where we already support a regular string?
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
    // TODO: Consider just calling Function.prototype[Symbol.hasInstance] directly
    return `((klass) => {
      if (
        klass &&
        typeof klass[Symbol.hasInstance] === 'function' &&
        klass[Symbol.hasInstance] !== Function.prototype[Symbol.hasInstance]
      ) {
        throw new Error('Posibility of side effect')
      } else {
        return ${compile(value[0])} instanceof klass
      }
    })(${value[1]})`
  } else if (type === 'len' || type === 'count') {
    return `((val) => {
      if (
        typeof val === 'string' ||
        Array.isArray(val) ||
        val instanceof Object.getPrototypeOf(Int8Array)
      ) {
        return val.length
      } else if (val instanceof Set || val instanceof Map) {
        return ${throwOnSideEffect('val', '"size"')}
      } else {
        throw new TypeError('Variable does not support len/count')
      }
    })(${compile(value)})`
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
          } else if (typeof ${args[1]} === 'string') {
            return ${args[0]}.match(${args[1]}) !== null
          } else {
            throw new TypeError('Variable ${args[1]} is not a string or RegExp')
          }
        } else {
          throw new TypeError('Variable ${args[0]} is not a string')
        }
      })()`
      case 'filter': return `((val) => {
          return ${isCollection('val')}
            ? Array.from(val).filter((it) => ${args[1]})
            : Object.entries(val).filter(([key, value]) => ${args[1]}).reduce((acc, [key, value]) => {
              acc[key] = value
              return acc
            }, {})
        })(${args[0]})`
      case 'substring': return `((val) => {
        if (typeof val === 'string') {
          return val.substring(${args[1]}, ${args[2]})
        } else {
          throw new TypeError('Variable is not a string')
        }
      })(${args[0]})`
      case 'getmember': return accessProperty(...args, false)
      case 'index': return accessProperty(...args, true)
    }
  }

  throw new TypeError(`Unknown AST node type: ${type}`)
}

function callMethodOnPrototype (variable, methodName, ...args) {
  return `Object.getPrototypeOf(${variable}).${methodName}.call(${variable}, ${args.join(', ')})`
}

function iterateOn (fnName, variable, callbackCode) {
  return `((val) => {
    return ${isCollection('val')}
      ? Array.from(val).${fnName}((it) => ${callbackCode})
      : Object.entries(val).${fnName}(([key, value]) => ${callbackCode})
  })(${variable})`
}

function isCollection (variable) {
  return `Array.isArray(${variable}) || ${variable} instanceof Set || ${variable} instanceof WeakSet`
}

function accessProperty (variable, keyOrIndex, allowMapAccess) {
  return `(() => {
    if (${variable} instanceof Set || ${variable} instanceof WeakSet) {
      throw new Error('Accessing a Set or WeakSet is not allowed')
    } else if (${variable} instanceof Map || ${variable} instanceof WeakMap) {
      ${allowMapAccess
        ? `return ${callMethodOnPrototype(variable, 'get', keyOrIndex)}`
        : 'throw new Error(\'Accessing a Map or WeakMap is not allowed\')'}
    } else {
      return ${throwOnSideEffect(variable, keyOrIndex)}
    }
  })()`
}

function throwOnSideEffect (variable, propertyName) {
  return `(() => {
    if (Object.getOwnPropertyDescriptor(${variable}, ${propertyName})?.get === undefined) {
      return ${variable}[${propertyName}]
    } else {
      throw new Error('Posibility of side effect')
    }
  })()`
}
