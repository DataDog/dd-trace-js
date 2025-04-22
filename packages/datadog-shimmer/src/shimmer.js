'use strict'

function copyProperties (original, wrapped) {
  // TODO getPrototypeOf is not fast. Should we instead do this in specific
  // instrumentations where needed?
  const proto = Object.getPrototypeOf(original)
  if (proto !== Function.prototype) {
    Object.setPrototypeOf(wrapped, proto)
  }
  const props = Object.getOwnPropertyDescriptors(original)
  const keys = Reflect.ownKeys(props)

  for (const key of keys) {
    try {
      Object.defineProperty(wrapped, key, props[key])
    } catch (e) {
      // TODO: figure out how to handle this without a try/catch
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
    assertFunction(wrapper)
  }

  const original = target[name]
  const wrapped = wrapper(original)

  const descriptor = Object.getOwnPropertyDescriptor(target, name)

  const attributes = {
    configurable: true,
    ...descriptor
  }

  if (typeof original === 'function') copyProperties(original, wrapped)

  if (descriptor) {
    if (descriptor.get || descriptor.set) {
      attributes.get = () => wrapped
    } else {
      attributes.value = wrapped
    }

    // TODO: create a single object for multiple wrapped methods
    if (descriptor.configurable === false) {
      return Object.create(target, {
        [name]: attributes
      })
    }
  } else { // no descriptor means original was on the prototype
    attributes.value = wrapped
    attributes.writable = true
  }

  Object.defineProperty(target, name, attributes)

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
  if (!target) {
    throw new Error('No target object provided.')
  }

  if (typeof target !== 'object' && typeof target !== 'function') {
    throw new Error('Invalid target.')
  }

  if (!target[name]) {
    throw new Error(`No original method ${name}.`)
  }

  if (typeof target[name] !== 'function') {
    throw new Error(`Original method ${name} is not a function.`)
  }
}

function assertFunction (target) {
  if (!target) {
    throw new Error('No function provided.')
  }

  if (typeof target !== 'function') {
    throw new Error('Target is not a function.')
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
