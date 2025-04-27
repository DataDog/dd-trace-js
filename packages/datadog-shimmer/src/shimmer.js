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
  if (ownKeys.length !== 2) {
    for (const key of ownKeys) {
      if (skipMethods.has(key)) continue
      const descriptor = Object.getOwnPropertyDescriptor(original, key)
      if (descriptor.writable && descriptor.enumerable && descriptor.configurable) {
        wrapped[key] = original[key]
      } else if (descriptor.writable || descriptor.configurable || !Object.hasOwn(wrapped, key)) {
        Object.defineProperty(wrapped, key, descriptor)
      }
    }
  }
}

function wrapFunction (original, wrapper) {
  const wrapped = wrapper(original)

  if (typeof original === 'function') {
    assertNotClass(original)
    copyProperties(original, wrapped)
  }

  return wrapped
}

function wrap (target, name, wrapper) {
  assertMethod(target, name)
  if (typeof wrapper !== 'function') {
    throw new Error(wrapper ? 'Target is not a function' : 'No function provided')
  }

  const original = target[name]
  const wrapped = wrapper(original)

  if (typeof original === 'function') copyProperties(original, wrapped)

  let descriptor = Object.getOwnPropertyDescriptor(target, name)

  // No descriptor means original was on the prototype
  if (descriptor === undefined) {
    descriptor = {
      value: wrapped,
      writable: true,
      configurable: true,
      enumerable: false
    }
  } else if (descriptor.writable) {
    // Fast path for assigned properties.
    if (descriptor.configurable && descriptor.enumerable) {
      target[name] = wrapped
      return target
    }
    descriptor.value = wrapped
  } else {
    if (descriptor.get || descriptor.set) {
      // TODO(BridgeAR): What happens in case there is a setter? This seems wrong?
      // What happens in case the user does indeed set this to a different value?
      // In that case the getter would potentially return the wrong value?
      descriptor.get = () => wrapped
    } else {
      descriptor.value = wrapped
    }

    if (descriptor.configurable === false) {
      // TODO(BridgeAR): Bail out instead (throw). It is unclear if the newly
      // created object is actually used. If it's not used, the wrapping would
      // have had no effect without noticing. It is also unclear what would happen
      // in case user code would check for properties to be own properties. That
      // would fail with this code. A function being replaced with an object is
      // also not possible.
      return Object.create(target, {
        [name]: descriptor
      })
    }
  }

  Object.defineProperty(target, name, descriptor)

  return target
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
    let message = 'No target object provided'

    if (target) {
      if (typeof target !== 'object' && typeof target !== 'function') {
        message = 'Invalid target'
      } else {
        message = target[name] ? `Original method ${name} is not a function` : `No original method ${name}`
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
