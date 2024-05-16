'use strict'

const desc = Reflect.getOwnPropertyDescriptor(process.versions, 'node')

desc.value = process.env.FAKE_VERSION

Reflect.defineProperty(process.versions, 'node', desc)
