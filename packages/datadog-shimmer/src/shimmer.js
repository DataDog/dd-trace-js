'use strict'

const DELEGATE = Symbol('delegate')

// Use weak maps to avoid polluting the wrapped function/method.
const originals = new WeakMap()
const wrappers = new WeakMap()
const descriptors = new WeakMap()

function copyProperties (original, wrapped) {
  Object.setPrototypeOf(wrapped, original)

  const props = Object.getOwnPropertyDescriptors(original)
  const names = Object.getOwnPropertyNames(props)
  const symbols = Object.getOwnPropertySymbols(props)
  const keys = names.concat(symbols)

  for (const key of keys) {
    if (key === 'name') continue
    Object.defineProperty(wrapped, key, props[key])
  }
}

function wrapFn (original, wrapped) {
  assertFunction(wrapped)

  const shim = function () {
    return wrapped[DELEGATE].apply(this, arguments)
  }

  originals.set(shim, original)
  wrappers.set(shim, wrapped)

  wrapped[DELEGATE] = wrapped // store as property to make access faster

  copyProperties(original, shim)

  return shim
}

function wrapMethod (target, name, wrapper) {
  assertMethod(target, name)
  assertFunction(wrapper)

  const original = target[name]
  const wrapped = wrapper(original)
  const descriptor = Object.getOwnPropertyDescriptor(target, name)

  descriptors.set(wrapped, descriptor)

  Object.defineProperty(target, name, {
    configurable: true,
    writable: true,
    enumerable: false,
    ...descriptor,
    value: wrapped
  })

  copyProperties(original, wrapped)

  return target
}

function wrap (target, name, wrapper) {
  return typeof name === 'function'
    ? wrapFn(target, name)
    : wrapMethod(target, name, wrapper)
}

function unwrapFn (target) {
  const original = originals.get(target)
  const wrapper = wrappers.get(target)

  // Keep the wrapper but restore the original as a delegate. This is needed
  // because there might be references to the function that cannot be updated,
  // so the only way to restore the original behaviour is with delegation.
  if (original && wrapper) {
    wrapper[DELEGATE] = original
  }

  return original || target
}

function unwrapMethod (target, name) {
  const descriptor = descriptors.get(target[name])

  if (descriptor) {
    Object.defineProperty(target, name, descriptor)
  } else {
    delete target[name] // no descriptor means original was on the prototype
  }

  return target
}

function unwrap (target, name) {
  if (!target) return target // no target to unwrap

  return name
    ? unwrapMethod(target, name)
    : unwrapFn(target)
}

function massWrap (targets, names, wrapper) {
  targets = [].concat(targets)
  names = [].concat(names)

  for (const target of targets) {
    for (const name of names) {
      wrap(target, name, wrapper)
    }
  }
}

function massUnwrap (targets, names) {
  targets = [].concat(targets)
  names = [].concat(names)

  for (const target of targets) {
    for (const name of names) {
      unwrap(target, name)
    }
  }
}

function assertMethod (target, name) {
  if (!target) {
    throw new Error('No target object provided.')
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

module.exports = {
  wrap,
  massWrap,
  unwrap,
  massUnwrap
}
