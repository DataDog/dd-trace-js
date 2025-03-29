'use strict'

module.exports = compile

// TODO: Consider storing some of these functions on `process` so they can be reused across probes
function compile (node) {
  if (node === null || typeof node === 'number' || typeof node === 'boolean' || typeof node === 'string') {
    return JSON.stringify(node)
  }

  const [type, value] = Object.entries(node)[0]

  if (type === 'not') {
    return `!(${compile(value)})`
  } else if (type === 'len' || type === 'count') {
    return getSize(compile(value))
  } else if (type === 'isEmpty') {
    return `${getSize(compile(value))} === 0`
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
    return `Function.prototype[Symbol.hasInstance].call(${value[1]}, ${compile(value[0])})`
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
      case 'eq': return `(${args[0]}) === (${args[1]})`
      case 'ne': return `(${args[0]}) !== (${args[1]})`
      case 'gt': return `${guardAgainstCoercionSideEffects(args[0])} > ${guardAgainstCoercionSideEffects(args[1])}`
      case 'ge': return `${guardAgainstCoercionSideEffects(args[0])} >= ${guardAgainstCoercionSideEffects(args[1])}`
      case 'lt': return `${guardAgainstCoercionSideEffects(args[0])} < ${guardAgainstCoercionSideEffects(args[1])}`
      case 'le': return `${guardAgainstCoercionSideEffects(args[0])} <= ${guardAgainstCoercionSideEffects(args[1])}`
      case 'any': return iterateOn('some', ...args)
      case 'all': return iterateOn('every', ...args)
      case 'and': return `(${args.join(') && (')})`
      case 'or': return `(${args.join(') || (')})`
      case 'startsWith': return `String.prototype.startsWith.call(${assertString(args[0])}, ${assertString(args[1])})`
      case 'endsWith': return `String.prototype.endsWith.call(${assertString(args[0])}, ${assertString(args[1])})`
      case 'contains': return `((obj, elm) => {
          if (${isString('obj')}) {
            return String.prototype.includes.call(obj, elm)
          } else if (Array.isArray(obj)) {
            return Array.prototype.includes.call(obj, elm)
          } else if (obj instanceof Object.getPrototypeOf(Int8Array)) {
            return Object.getPrototypeOf(Int8Array.prototype).includes.call(obj, elm)
          } else if (obj instanceof Set) {
            return Set.prototype.has.call(obj, elm)
          } else if (obj instanceof WeakSet) {
            return WeakSet.prototype.has.call(obj, elm)
          } else if (obj instanceof Map) {
            return Map.prototype.has.call(obj, elm)
          } else if (obj instanceof WeakMap) {
            return WeakMap.prototype.has.call(obj, elm)
          } else {
            throw new TypeError('Variable does not support contains')
          }
        })(${args[0]}, ${args[1]})`
      case 'matches': return `((str, regex) => {
          if (${isString('str')}) {
            if (Object.getPrototypeOf(regex) === RegExp.prototype) {
              return RegExp.prototype.test.call(regex, str)
            } else if (${isString('regex')}) {
              return String.prototype.match.call(str, regex) !== null
            } else {
              throw new TypeError('Regular expression must be either a string or an instance of RegExp')
            }
          } else {
            throw new TypeError('Variable is not a string')
          }
        })(${args[0]}, ${args[1]})`
      case 'filter': return `(($dd_var) => {
          return ${isIterableCollection('$dd_var')}
            ? Array.from($dd_var).filter(($dd_it) => ${args[1]})
            : Object.entries($dd_var).filter(([$dd_key, $dd_value]) => ${args[1]}).reduce((acc, [k, v]) => {
                acc[k] = v
                return acc
              }, {})
        })(${args[0]})`
      case 'substring': return `((str) => {
          if (${isString('str')}) {
            return String.prototype.substring.call(str, ${args[1]}, ${args[2]})
          } else {
            throw new TypeError('Variable is not a string')
          }
        })(${args[0]})`
      case 'getmember': return accessProperty(args[0], args[1], false)
      case 'index': return accessProperty(args[0], args[1], true)
    }
  }

  throw new TypeError(`Unknown AST node type: ${type}`)
}

function iterateOn (fnName, variable, callbackCode) {
  return `(($dd_val) => {
    return ${isIterableCollection('$dd_val')}
      ? Array.from($dd_val).${fnName}(($dd_it) => ${callbackCode})
      : Object.entries($dd_val).${fnName}(([$dd_key, $dd_value]) => ${callbackCode})
  })(${variable})`
}

function isString (variable) {
  return `typeof ${variable} === 'string' || ${variable} instanceof String`
}

function isIterableCollection (variable) {
  return `${isArrayOrTypedArray(variable)} || ${variable} instanceof Set || ${variable} instanceof WeakSet`
}

function isArrayOrTypedArray (variable) {
  return `Array.isArray(${variable}) || ${variable} instanceof Object.getPrototypeOf(Int8Array)`
}

function getSize (variable) {
  return `((val) => {
    if (${isString('val')} || ${isArrayOrTypedArray('val')}) {
      return ${guardAgainstPropertyAccessSideEffects('val', '"length"')}
    } else if (val instanceof Set || val instanceof Map) {
      return ${guardAgainstPropertyAccessSideEffects('val', '"size"')}
    } else {
      throw new TypeError('Cannot get length or size of string/collection')
    }
  })(${variable})`
}

function accessProperty (variable, keyOrIndex, allowMapAccess) {
  return `((val, key) => {
    if (val instanceof Set || val instanceof WeakSet) {
      throw new Error('Accessing a Set or WeakSet is not allowed')
    } else if (val instanceof Map) {
      ${allowMapAccess
        ? 'return Map.prototype.get.call(val, key)'
        : 'throw new Error(\'Accessing a Map is not allowed\')'}
    } else if (val instanceof WeakMap) {
      ${allowMapAccess
        ? 'return WeakMap.prototype.get.call(val, key)'
        : 'throw new Error(\'Accessing a WeakMap is not allowed\')'}
    } else {
      return ${guardAgainstPropertyAccessSideEffects('val', 'key')}
    }
  })(${variable}, ${keyOrIndex})`
}

function guardAgainstPropertyAccessSideEffects (variable, propertyName) {
  return `((val, key) => {
    if (${maybeProxy('val')} || Object.getOwnPropertyDescriptor(val, key)?.get !== undefined) {
      throw new Error('Possibility of side effect')
    } else {
      return val[key]
    }
  })(${variable}, ${propertyName})`
}

function guardAgainstCoercionSideEffects (variable) {
  return `((val) => {
    if (
      typeof val === 'object' && val !== null && (
        ${maybeProxy('val')} ||
        val[Symbol.toPrimitive] !== undefined ||
        val.valueOf !== Object.prototype.valueOf ||
        val.toString !== Object.prototype.toString
      )
    ) {
      throw new Error('Possibility of side effect due to coercion methods')
    } else {
      return val
    }
  })(${variable})`
}

function maybeProxy (variable) {
  return `(process[Symbol.for('datadog:isProxy')]?.(${variable}) ?? true)`
}

function assertString (variable) {
  return `((val) => {
    if (typeof val === 'string' || val instanceof String) {
      return val
    } else {
      throw new TypeError('Variable is not a string')
    }
  })(${variable})`
}
