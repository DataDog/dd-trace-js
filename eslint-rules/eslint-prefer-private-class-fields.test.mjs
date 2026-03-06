import { RuleTester } from 'eslint'
import rule from './eslint-prefer-private-class-fields.mjs'

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022 },
})

ruleTester.run('prefer-private-class-fields', /** @type {import('eslint').Rule.RuleModule} */ (rule), {
  valid: [
    // Already private
    'class Foo { #bar = 1; get() { return this.#bar } }',

    // Accessed externally (outside any class) — cannot be privatized
    `
      class Foo {
        _x = 1
      }
      const f = new Foo()
      f._x = 2
    `,

    // Accessed in a second class — cannot be privatized
    `
      class A { _x = 1 }
      class B { method(a) { return a._x } }
    `,

    // Destructured from this — incompatible with private fields
    `
      class Foo {
        _url = 'http://example.com'
        send() {
          const { _url } = this
          return _url
        }
      }
    `,

    // Destructured from an argument — incompatible with private fields
    `
      class Foo {
        _data = null
        merge(other) {
          const { _data } = other
          return _data
        }
      }
    `,

    // No underscore properties
    'class Foo { bar = 1; get() { return this.bar } }',

    // Bare underscore (single char) — not a naming convention marker
    'class Foo { method(x) { return x._ } }',

    // Constructor-only assignment without a class field declaration cannot be safely
    // auto-fixed (private fields must be declared in the class body).
    `
      class Foo {
        constructor() { this._bar = 1 }
        get() { return this._bar }
      }
    `,

    // No class body at all (free variable)
    'function f(_x) { return _x + 1 }',

    // Method definition — not flagged because sinon.stub(instance, '_method') in test files
    // cannot stub private methods; privatizing methods would break external test stubs.
    'class Service { _helper() { return 42 } }',

    // Method definition with in-file access — methods are not privatized (same reason above).
    `
      class Service {
        _helper() { return 42 }
        run() { return this._helper() }
      }
    `,

    // super._foo is a cross-class call; super.#foo is syntactically invalid.
    `
      class Base { _render() { return 'base' } }
      class Child extends Base {
        _render() { return super._render() + ' child' }
      }
    `,
  ],

  invalid: [
    // Class field declaration + access via this.
    // Reports one error per occurrence (1 definition + 2 accesses = 3 errors).
    {
      code: `
        class Counter {
          _count = 0
          increment() { this._count++ }
          get value() { return this._count }
        }
      `,
      errors: [
        { messageId: 'preferPrivate', data: { name: '_count', className: 'Counter', privateName: 'count' } },
        { messageId: 'preferPrivate', data: { name: '_count', className: 'Counter', privateName: 'count' } },
        { messageId: 'preferPrivate', data: { name: '_count', className: 'Counter', privateName: 'count' } },
      ],
      output: `
        class Counter {
          #count = 0
          increment() { this.#count++ }
          get value() { return this.#count }
        }
      `,
    },

    // Cross-instance access within the same class (like histogram.merge).
    // Private fields can be accessed on any instance of the same class, not just `this`.
    // Reports 1 definition + 2 accesses = 3 errors.
    {
      code: `
        class Histogram {
          _sketch = {}
          merge(other) { return this._sketch.merge(other._sketch) }
        }
      `,
      errors: [
        { messageId: 'preferPrivate', data: { name: '_sketch', className: 'Histogram', privateName: 'sketch' } },
        { messageId: 'preferPrivate', data: { name: '_sketch', className: 'Histogram', privateName: 'sketch' } },
        { messageId: 'preferPrivate', data: { name: '_sketch', className: 'Histogram', privateName: 'sketch' } },
      ],
      output: `
        class Histogram {
          #sketch = {}
          merge(other) { return this.#sketch.merge(other.#sketch) }
        }
      `,
    },

    // Multiple privatizable properties in one class.
    // ESLint sorts errors by source position, so definitions come first (in source order),
    // then accesses (in source order on the same line).
    // _host PropDef, _port PropDef, _host ME (this._host), _port ME (this._port)
    {
      code: `
        class Config {
          _host = 'localhost'
          _port = 8080
          url() { return this._host + ':' + this._port }
        }
      `,
      errors: [
        { messageId: 'preferPrivate', data: { name: '_host', className: 'Config', privateName: 'host' } },
        { messageId: 'preferPrivate', data: { name: '_port', className: 'Config', privateName: 'port' } },
        { messageId: 'preferPrivate', data: { name: '_host', className: 'Config', privateName: 'host' } },
        { messageId: 'preferPrivate', data: { name: '_port', className: 'Config', privateName: 'port' } },
      ],
      output: `
        class Config {
          #host = 'localhost'
          #port = 8080
          url() { return this.#host + ':' + this.#port }
        }
      `,
    },

    // Getter and setter methods accessing a private field.
    // _val is a getter/setter (MethodDefinition) — not flagged because methods are excluded.
    // _value is a PropertyDefinition with MemberExpression accesses — flagged (PropDef + 2 MEs).
    {
      code: `
        class Box {
          _value = null
          get _val() { return this._value }
          set _val(v) { this._value = v }
        }
      `,
      errors: [
        { messageId: 'preferPrivate', data: { name: '_value', className: 'Box', privateName: 'value' } },
        { messageId: 'preferPrivate', data: { name: '_value', className: 'Box', privateName: 'value' } },
        { messageId: 'preferPrivate', data: { name: '_value', className: 'Box', privateName: 'value' } },
      ],
      output: `
        class Box {
          #value = null
          get _val() { return this.#value }
          set _val(v) { this.#value = v }
        }
      `,
    },

    // _val accessed via this._val — but _val has no PropertyDefinition, only MethodDefinitions.
    // So _val is not flagged. _value is flagged (PropDef + 2 MEs in getter/setter body).
    {
      code: `
        class Box {
          _value = null
          get _val() { return this._value }
          set _val(v) { this._value = v }
          clear() { this._val = null }
          display() { return this._val }
        }
      `,
      errors: [
        { messageId: 'preferPrivate', data: { name: '_value', className: 'Box', privateName: 'value' } },
        { messageId: 'preferPrivate', data: { name: '_value', className: 'Box', privateName: 'value' } },
        { messageId: 'preferPrivate', data: { name: '_value', className: 'Box', privateName: 'value' } },
      ],
      output: `
        class Box {
          #value = null
          get _val() { return this.#value }
          set _val(v) { this.#value = v }
          clear() { this._val = null }
          display() { return this._val }
        }
      `,
    },

    // Anonymous class expression
    {
      code: `
        const Foo = class {
          _x = 1
          get() { return this._x }
        }
      `,
      errors: [
        { messageId: 'preferPrivate', data: { name: '_x', className: '<anonymous>', privateName: 'x' } },
        { messageId: 'preferPrivate', data: { name: '_x', className: '<anonymous>', privateName: 'x' } },
      ],
      output: `
        const Foo = class {
          #x = 1
          get() { return this.#x }
        }
      `,
    },

    // Static class fields
    {
      code: `
        class Registry {
          static _instance = null
          static getInstance() { return Registry._instance }
        }
      `,
      errors: [
        { messageId: 'preferPrivate', data: { name: '_instance', className: 'Registry', privateName: 'instance' } },
        { messageId: 'preferPrivate', data: { name: '_instance', className: 'Registry', privateName: 'instance' } },
      ],
      output: `
        class Registry {
          static #instance = null
          static getInstance() { return Registry.#instance }
        }
      `,
    },
  ],
})
