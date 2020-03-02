'use strict'

const Decorator = require('../src/decorator')
const Tracer = require('../../dd-trace')
const tags = require('../../../ext/tags')

wrapIt()

describe('Decorator', () => {
  const sandbox = sinon.createSandbox()
  const decorator = new Decorator(Tracer)

  before(() => {
    sandbox.spy(decorator)
  })

  afterEach(() => {
    sandbox.resetHistory()
  })

  describe('differentiating between classes and methods', () => {
    it('should call _traceMethod if used to decorate a method', () => {
      // eslint-disable-next-line no-unused-vars
      class TestClass {
        @decorator.trace()
        decoratedMethod () {}
      }

      expect(decorator._traceMethod).to.have.been.called
      expect(decorator._traceClass).to.have.not.been.called
    })

    it('should call _traceClass if used to decorate a class', () => {
      @decorator.trace()
      // eslint-disable-next-line no-unused-vars
      class TestClass {
        method () {}
      }

      expect(decorator._traceClass).to.have.been.called
    })
  })

  describe('tracing a class', () => {
    it('should trace each method of the class', () => {
      @decorator.trace()
      // eslint-disable-next-line no-unused-vars
      class TestClass {
        methodOne () {}
        methodTwo () {}
        methodThree () {}
      }

      const [
        [,, firstPropertyKey],
        [,, secondPropertyKey],
        [,, thirdPropertyKey]
      ] = decorator._traceMethod.args

      expect(decorator._traceMethod).to.have.been.calledThrice
      expect(firstPropertyKey).to.equal('methodOne')
      expect(secondPropertyKey).to.equal('methodTwo')
      expect(thirdPropertyKey).to.equal('methodThree')
    })
  })

  describe('tracing a method', () => {
    it('should pass the method name to _traceFunction', () => {
      // eslint-disable-next-line no-unused-vars
      class TestClass {
        @decorator.trace()
        decoratedMethod () {}
      }

      const [[{ className }]] = decorator._traceFunction.args

      expect(className).to.equal('TestClass')
    })

    it('should pass the class name to _traceFunction', () => {
      // eslint-disable-next-line no-unused-vars
      class TestClass {
        @decorator.trace()
        decoratedMethod () {}
      }

      const [[{ methodName }]] = decorator._traceFunction.args

      expect(methodName).to.equal('decoratedMethod')
    })
  })

  describe('tracing a function', () => {
    it('should not modify the method', () => {
      function add (a, b) { return a + b }

      @decorator.trace()
      class TestClass {
        add (...args) { return add(...args) }
      }

      const input = [1, 2]
      const output = (new TestClass()).add(...input)
      const expectedOutput = add(...input)

      expect(output).to.equal(expectedOutput)
    })

    it('should handle async method', async () => {
      function add (a, b) { return a + b }

      @decorator.trace()
      class TestClass {
        async thenableAdd (...args) { return add(...args) }
      }

      const input = [1, 2]
      const thenableOutput = (new TestClass()).thenableAdd(...input)
      const expectedOutput = add(...input)

      expect(typeof thenableOutput.then).to.equal('function')
      expect(await thenableOutput).to.equal(expectedOutput)
    })

    it('should not change the method\'s "this"', async () => {
      function add (a, b) { return a + b }

      @decorator.trace()
      class TestClass {
        constructor (input) {
          this._input = input
        }

        addUsingClassProperty () {
          return add(...this._input)
        }
      }

      const input = [1, 2]
      const output = (new TestClass(input)).addUsingClassProperty()
      const expectedOutput = add(...input)

      expect(output).to.equal(expectedOutput)
    })

    describe('decorator configuration', () => {
      it('should create default values if no configuration is sent', () => {
        const spy = sinon.spy(decorator._tracer, 'startSpan')

        class TestClass {
          @decorator.trace()
          decoratedMethod () {}
        }

        // eslint-disable-next-line new-parens
        (new TestClass).decoratedMethod()

        const [[spanName, spanOptions]] = spy.args

        expect(spanName).to.equal('DECORATED_SPAN')
        expect(spanOptions.tags[tags.RESOURCE_NAME]).to.equal('TestClass.decoratedMethod')
        expect(spanOptions.tags[tags.SERVICE_NAME]).to.equal('service.name-decorated-span')
        expect(spanOptions.tags[tags.ANALYTICS]).to.be.undefined

        spy.restore()
      })

      it('should create allow configuration to override defaults', () => {
        const spy = sinon.spy(decorator._tracer, 'startSpan')

        class TestClass {
          @decorator.trace({
            serviceName: 'test-service',
            resourceName: 'test-resource',
            spanName: 'test-span',
            appAnalytics: true,
            tags: { foo: 'bar' }
          })
          decoratedMethod () {}
        }

        // eslint-disable-next-line new-parens
        (new TestClass).decoratedMethod()

        const [[spanName, spanOptions]] = spy.args

        expect(spanName).to.equal('test-span')
        expect(spanOptions.tags[tags.SERVICE_NAME]).to.equal('service.name-test-service')
        expect(spanOptions.tags[tags.RESOURCE_NAME]).to.equal('test-resource')
        expect(spanOptions.tags[tags.ANALYTICS]).to.be.true
        expect(spanOptions.tags.foo).to.equal('bar')

        spy.restore()
      })
    })
  })
})
