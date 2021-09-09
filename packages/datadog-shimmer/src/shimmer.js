'use strict'

const ORIGINAL = Symbol('original')
const DELEGATE = Symbol('delegate')

function defineProperty (obj, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(obj, name)
  const enumerable = name in obj && descriptor && descriptor.enumerable

  if (enumerable) {
    obj[name] = value
  } else {
    Object.defineProperty(obj, name, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: value
    })
  }
}

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
    return shim[DELEGATE].apply(this, arguments)
  }

  defineProperty(shim, ORIGINAL, original)
  defineProperty(shim, DELEGATE, wrapped)

  copyProperties(original, shim)

  return shim
}

function wrapMethod (target, name, wrapper) {
  assertMethod(target, name)
  assertFunction(wrapper)

  const original = target[name]
  const wrapped = wrapper(original)

  defineProperty(wrapped, ORIGINAL, original)
  defineProperty(target, name, wrapped)

  copyProperties(original, wrapped)

  return target
}

function wrap (target, name, wrapper) {
  return typeof name === 'function'
    ? wrapFn(target, name)
    : wrapMethod(target, name, wrapper)
}

function unwrapFn (target) {
  if (target && target[ORIGINAL]) {
    defineProperty(target, DELEGATE, target[ORIGINAL])
  }

  return target[ORIGINAL]
}

function unwrapMethod (target, name) {
  if (target && target[name] && target[name][ORIGINAL]) {
    defineProperty(target, name, target[name][ORIGINAL])
  }

  return target
}

function unwrap (target, name) {
  return name ? unwrapMethod(target, name) : unwrapFn(target)
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
