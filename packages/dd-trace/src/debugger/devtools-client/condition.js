'use strict'

module.exports = {
  compile,
  compileSegments,
  templateRequiresEvaluation
}

const identifierRegex = /^[@a-zA-Z_$][\w$]*$/

// The following identifiers have purposefully not been included in this list:
// - The reserved words `this` and `super` as they can have valid use cases as `ref` values
// - The literals `undefined` and `Infinity` as they can be useful as `ref` values, especially to check if a
//   variable is `undefined`.
// - The following future reserved words in older standards, as they can now be used safely:
//   `abstract`, `boolean`, `byte`, `char`, `double`, `final`, `float`, `goto`, `int`, `long`, `native`, `short`,
//   `synchronized`, `throws`, `transient`, `volatile`.
const reservedWords = new Set([
  // Reserved words
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export',
  'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return',
  'switch', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',

  // Reserved in strict mode
  'let', 'static', 'yield',

  // Reserved in module code or async function bodies:
  'await',

  // Future reserved words
  'enum',

  // Future reserved words in strict mode
  'implements', 'interface', 'package', 'private', 'protected', 'public',

  // Litterals
  'NaN'
])

const PRIMITIVE_TYPES = new Set(['string', 'number', 'bigint', 'boolean', 'undefined', 'symbol', 'null'])

function templateRequiresEvaluation (segments) {
  if (segments === undefined) return false // There should always be segments, but just in case
  for (const { str } of segments) {
    if (str === undefined) return true
  }
  return false
}

function compileSegments (segments) {
  let result = '['
  for (let i = 0; i < segments.length; i++) {
    const { str, dsl, json } = segments[i]
    result += str === undefined
      ? `(() => {
          try {
            const result = ${compile(json)}
            return typeof result === 'string' ? result : $dd_inspect(result, $dd_segmentInspectOptions)
          } catch (e) {
            return { expr: ${JSON.stringify(dsl)}, message: \`\${e.name}: \${e.message}\` }
          }
        })()`
      : JSON.stringify(str)
    if (i !== segments.length - 1) {
      result += ','
    }
  }
  return `${result}]`
}

// TODO: Consider storing some of these functions that doesn't require closure access to the current scope on `process`
// so they can be reused across probes
function compile (node) {
  if (node === null || typeof node === 'number' || typeof node === 'boolean') {
    return node
  } else if (typeof node === 'string') {
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
        ${compile(value)}
        return true
      } catch {
        return false
      }
    })()`
  } else if (type === 'instanceof') {
    return isPrimitiveType(value[1])
      ? `(typeof ${compile(value[0])} === '${value[1]}')` // TODO: Is parenthesizing necessary?
      : `Function.prototype[Symbol.hasInstance].call(${assertIdentifier(value[1])}, ${compile(value[0])})`
  } else if (type === 'ref') {
    if (value === '@it') {
      return '$dd_it'
    } else if (value === '@key') {
      return '$dd_key'
    } else if (value === '@value') {
      return '$dd_value'
    }
    return assertIdentifier(value)
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
          } else if (${isTypedArray('obj')}) {
            return Object.getPrototypeOf(Int8Array.prototype).includes.call(obj, elm)
          } else if (${isInstanceOfCoreType('Set', 'obj')}) {
            return Set.prototype.has.call(obj, elm)
          } else if (${isInstanceOfCoreType('WeakSet', 'obj')}) {
            return WeakSet.prototype.has.call(obj, elm)
          } else if (${isInstanceOfCoreType('Map', 'obj')}) {
            return Map.prototype.has.call(obj, elm)
          } else if (${isInstanceOfCoreType('WeakMap', 'obj')}) {
            return WeakMap.prototype.has.call(obj, elm)
          } else {
            throw new TypeError('Variable does not support contains')
          }
        })(${args[0]}, ${args[1]})`
      case 'matches': return `((str, regex) => {
          if (${isString('str')}) {
            const regexIsString = ${isString('regex')}
            if (regexIsString || Object.getPrototypeOf(regex) === RegExp.prototype) {
              return RegExp.prototype.test.call(regexIsString ? new RegExp(regex) : regex, str)
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
            : Object.entries($dd_var).reduce((acc, [$dd_key, $dd_value]) => {
                if (${args[1]}) acc[$dd_key] = $dd_value
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
  return `(typeof ${variable} === 'string' || ${variable} instanceof String)`
}

function isPrimitiveType (type) {
  return PRIMITIVE_TYPES.has(type)
}

function isIterableCollection (variable) {
  return `(${isArrayOrTypedArray(variable)} || ${isInstanceOfCoreType('Set', variable)} || ` +
    `${isInstanceOfCoreType('WeakSet', variable)})`
}

function isArrayOrTypedArray (variable) {
  return `(Array.isArray(${variable}) || ${isTypedArray(variable)})`
}

function isTypedArray (variable) {
  return isInstanceOfCoreType('TypedArray', variable, `${variable} instanceof Object.getPrototypeOf(Int8Array)`)
}

function isInstanceOfCoreType (type, variable, fallback = `${variable} instanceof ${type}`) {
  return `(process[Symbol.for('datadog:node:util:types')]?.is${type}?.(${variable}) ?? ${fallback})`
}

function getSize (variable) {
  return `((val) => {
    if (${isString('val')} || ${isArrayOrTypedArray('val')}) {
      return ${guardAgainstPropertyAccessSideEffects('val', '"length"')}
    } else if (${isInstanceOfCoreType('Set', 'val')} || ${isInstanceOfCoreType('Map', 'val')}) {
      return ${guardAgainstPropertyAccessSideEffects('val', '"size"')}
    } else if (${isInstanceOfCoreType('WeakSet', 'val')} || ${isInstanceOfCoreType('WeakMap', 'val')}) {
      throw new TypeError('Cannot get size of WeakSet or WeakMap')
    } else if (typeof val === 'object' && val !== null) {
      return Object.keys(val).length
    } else {
      throw new TypeError('Cannot get length of variable')
    }
  })(${variable})`
}

function accessProperty (variable, keyOrIndex, allowMapAccess) {
  return `((val, key) => {
    if (${isInstanceOfCoreType('Map', 'val')}) {
      ${allowMapAccess
        ? 'return Map.prototype.get.call(val, key)'
        : 'throw new Error(\'Accessing a Map is not allowed\')'}
    } else if (${isInstanceOfCoreType('WeakMap', 'val')}) {
      ${allowMapAccess
        ? 'return WeakMap.prototype.get.call(val, key)'
        : 'throw new Error(\'Accessing a WeakMap is not allowed\')'}
    } else if (${isInstanceOfCoreType('Set', 'val')} || ${isInstanceOfCoreType('WeakSet', 'val')}) {
      throw new Error('Accessing a Set or WeakSet is not allowed')
    } else {
      return ${guardAgainstPropertyAccessSideEffects('val', 'key')}
    }
  })(${variable}, ${keyOrIndex})`
}

function guardAgainstPropertyAccessSideEffects (variable, propertyName) {
  return `((val, key) => {
    if (
      ${isInstanceOfCoreType('Proxy', 'val', 'true')} ||
      Object.getOwnPropertyDescriptor(val, key)?.get !== undefined
    ) {
      throw new Error('Possibility of side effect')
    } else {
      return val[key]
    }
  })(${variable}, ${propertyName})`
}

function guardAgainstCoercionSideEffects (variable) {
  // shortcut if we're comparing number literals
  if (typeof variable === 'number') return variable

  return `((val) => {
    if (
      typeof val === 'object' && val !== null && (
        ${isInstanceOfCoreType('Proxy', 'val', 'true')} ||
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

function assertString (variable) {
  return `((val) => {
    if (${isString('val')}) {
      return val
    } else {
      throw new TypeError('Variable is not a string')
    }
  })(${variable})`
}

function assertIdentifier (value) {
  if (!identifierRegex.test(value) || reservedWords.has(value)) {
    throw new SyntaxError(`Illegal identifier: ${value}`)
  }
  return value
}
