'use strict'

// Use a weak map to avoid polluting the wrapped function/method.
const unwrappers = new WeakMap()

function copyProperties (original, wrapped) {
  Object.setPrototypeOf(wrapped, original)

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

function wrapFn (original, delegate) {
  assertFunction(delegate)
  assertNotClass(original) // TODO: support constructors of native classes

  const shim = function shim () {
    return delegate.apply(this, arguments)
  }

  unwrappers.set(shim, () => {
    delegate = original
  })

  copyProperties(original, shim)

  return shim
}

function wrapMethod (target, name, wrapper) {
  assertMethod(target, name)
  assertFunction(wrapper)

  const original = target[name]
  const wrapped = wrapper(original)
  const descriptor = Object.getOwnPropertyDescriptor(target, name)

  const attributes = {
    configurable: true,
    ...descriptor
  }

  copyProperties(original, wrapped)

  if (descriptor) {
    unwrappers.set(wrapped, () => Object.defineProperty(target, name, descriptor))

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
    unwrappers.set(wrapped, () => delete target[name])
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

function unwrap (target, name) {
  if (!target) return target // no target to unwrap

  const unwrapper = unwrappers.get(name ? target[name] : target)

  if (!unwrapper) return target // target is already unwrapped or isn't wrapped

  unwrapper()

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

function massUnwrap (targets, names) {
  targets = toArray(targets)
  names = toArray(names)

  for (const target of targets) {
    for (const name of names) {
      unwrap(target, name)
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
  massWrap,
  unwrap,
  massUnwrap
}
