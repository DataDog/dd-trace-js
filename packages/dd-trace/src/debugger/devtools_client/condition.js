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
    return `(($dd_class) => {
      if (
        $dd_class &&
        typeof $dd_class[Symbol.hasInstance] === 'function' &&
        $dd_class[Symbol.hasInstance] !== Function.prototype[Symbol.hasInstance]
      ) {
        throw new Error('Possibility of side effect')
      } else {
        return ${compile(value[0])} instanceof $dd_class
      }
    })(${value[1]})`
  } else if (type === 'len' || type === 'count') {
    return `(($dd_val) => {
      if (
        typeof $dd_val === 'string' ||
        Array.isArray($dd_val) ||
        $dd_val instanceof Object.getPrototypeOf(Int8Array)
      ) {
        return $dd_val.length
      } else if ($dd_val instanceof Set || $dd_val instanceof Map) {
        return ${guardAgainstPropertyAccessSideEffects('$dd_val', '"size"')}
      } else {
        throw new TypeError('Variable does not support len/count')
      }
    })(${compile(value)})`
  } else if (type === 'ref') {
    if (value === '@it') {
      return '$dd_it'
    } else if (value === '@key') {
      return '$dd_key'
    } else if (value === '@value') {
      return '$dd_value'
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
      case 'matches': return `(($dd_str, $dd_regex) => {
          if (typeof $dd_str === 'string') {
            if ($dd_regex instanceof RegExp) {
              return ${callMethodOnPrototype('$dd_regex', 'test', '$dd_str')}
            } else if (typeof $dd_regex === 'string') {
              return $dd_str.match($dd_regex) !== null
            } else {
              throw new TypeError('Variable is not a string or RegExp')
            }
          } else {
            throw new TypeError('Variable is not a string')
          }
        })(${args[0]}, ${args[1]})`
      case 'filter': return `(($dd_var) => {
          return ${isCollection('$dd_var')}
            ? Array.from($dd_var).filter(($dd_it) => ${args[1]})
            : Object.entries($dd_var).filter(([$dd_key, $dd_value]) => ${args[1]}).reduce((acc, [k, v]) => {
                acc[k] = v
                return acc
              }, {})
        })(${args[0]})`
      case 'substring': return `(($dd_str) => {
          if (typeof $dd_str === 'string') {
            return $dd_str.substring(${args[1]}, ${args[2]})
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
  return `(($dd_val) => {
    return ${isCollection('$dd_val')}
      ? Array.from($dd_val).${fnName}(($dd_it) => ${callbackCode})
      : Object.entries($dd_val).${fnName}(([$dd_key, $dd_value]) => ${callbackCode})
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
      return ${guardAgainstPropertyAccessSideEffects(variable, keyOrIndex)}
    }
  })()`
}

function guardAgainstPropertyAccessSideEffects (variable, propertyName) {
  return `(() => {
    const isProxy = process[Symbol.for('datadog:isProxy')]
    if (
      !isProxy ||
      isProxy(${variable}) ||
      Object.getOwnPropertyDescriptor(${variable}, ${propertyName})?.get !== undefined
    ) {
      throw new Error('Possibility of side effect')
    } else {
      return ${variable}[${propertyName}]
    }
  })()`
}
