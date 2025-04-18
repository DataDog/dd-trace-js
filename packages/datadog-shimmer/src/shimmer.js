'use strict'

const skipMethods = new Set([
  'caller',
  'arguments',
  'name',
  'length'
])

function copyProperties (original, wrapped) {
  if (original.constructor !== wrapped.constructor) {
    const proto = Object.getPrototypeOf(original)
    Object.setPrototypeOf(wrapped, proto)
  }

  const ownKeys = Reflect.ownKeys(original)
  if (original.length !== wrapped.length) {
    Object.defineProperty(wrapped, 'length', { value: original.length, configurable: true })
  }
  if (original.name !== wrapped.name) {
    Object.defineProperty(wrapped, 'name', { value: original.name, configurable: true })
  }
  if (ownKeys.length === 2) {
    return
  }
  for (const key of ownKeys) {
    if (skipMethods.has(key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(original, key)
    if (descriptor?.writable || descriptor?.configurable || !Object.prototype.hasOwnProperty.call(wrapped, key)) {
      Object.defineProperty(wrapped, key, descriptor)
    }
  }
}

function wrapFunction (original, wrapper) {
  if (typeof original === 'function') assertNotClass(original)

  const wrapped = wrapper(original)

  if (typeof original === 'function') copyProperties(original, wrapped)

  return wrapped
}

const wrapFn = function (original, delegate) {
  throw new Error('calling `wrap()` with 2 args is deprecated. Use wrapFunction instead.')
}

function wrapMethod (target, name, wrapper, noAssert) {
  if (!noAssert) {
    assertMethod(target, name)
    if (typeof wrapper !== 'function') {
      throw new Error(wrapper ? 'Target is not a function.' : 'No function provided.')
    }
  }

  const original = target[name]
  const wrapped = wrapper(original)

  if (typeof original === 'function') copyProperties(original, wrapped)

  const descriptor = Object.getOwnPropertyDescriptor(target, name)

  if (descriptor) {
    if (descriptor.get || descriptor.set) {
      // TODO(BridgeAR): What happens in case there is a setter? This seems wrong?
      // What happens in case the user does indeed set this to a different value?
      // In that case the getter would potentially return the wrong value?
      descriptor.get = () => wrapped
    } else {
      descriptor.value = wrapped
    }

    // TODO: create a single object for multiple wrapped methods
    if (descriptor.configurable === false) {
      return Object.create(target, {
        [name]: descriptor
      })
    }
  } else { // no descriptor means original was on the prototype
    target[name] = wrapped
    return target
  }

  Object.defineProperty(target, name, descriptor)

  return target
}

function wrap (target, name, wrapper) {
  return typeof name === 'function'
    ? wrapFn(target, name)
    : wrapMethod(target, name, wrapper)
}

function massWrap (targets, names, wrapper) {
  targets = toArray(targets)
  names = toArray(names)

  for (const target of targets) {
    for (const name of names) {
      wrap(target, name, wrapper)
    }
  }
}

function toArray (maybeArray) {
  return Array.isArray(maybeArray) ? maybeArray : [maybeArray]
}

function assertMethod (target, name) {
  if (typeof target?.[name] !== 'function') {
    let message = 'No target object provided.'

    if (target) {
      if (typeof target !== 'object' && typeof target !== 'function') {
        message = 'Invalid target.'
      } else {
        message = target[name] ? `Original method ${name} is not a function.` : `No original method ${name}.`
      }
    }

    throw new Error(message)
  }
}

function assertNotClass (target) {
  if (Function.prototype.toString.call(target).startsWith('class')) {
    throw new Error('Target is a native class constructor and cannot be wrapped.')
  }
}

module.exports = {
  wrap,
  wrapFunction,
  massWrap
}
