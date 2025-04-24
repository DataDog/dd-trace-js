'use strict'

require('../../setup/mocha')

describe('breakpoints', function () {
  let breakpoints
  let sessionMock
  let stateMock

  beforeEach(function () {
    sessionMock = {
      post: sinon.stub().callsFake((method, { location } = {}) => {
        if (method === 'Debugger.setBreakpoint') {
          return Promise.resolve({
            breakpointId: `bp-${location.scriptId}:${location.lineNumber}:${location.columnNumber}`
          })
        }
        return Promise.resolve({})
      }),
      '@noCallThru': true
    }

    stateMock = {
      findScriptFromPartialPath: sinon.stub().returns({
        url: 'file:///path/to/test.js',
        scriptId: 'script-1',
        sourceMapURL: null,
        source: null
      }),
      locationToBreakpoint: new Map(),
      breakpointToProbes: new Map(),
      probeToLocation: new Map(),
      '@noCallThru': true
    }

    breakpoints = proxyquire('../src/debugger/devtools_client/breakpoints', {
      './session': sessionMock,
      './state': stateMock
    })
  })

  describe('addBreakpoint', function () {
    it('should enable debugger for the first breakpoint', async function () {
      await breakpoints.addBreakpoint({
        id: 'probe-1',
        version: 1,
        where: {
          sourceFile: 'test.js',
          lines: ['10']
        }
      })

      expect(sessionMock.post.callCount).to.equal(2)
      expect(sessionMock.post.firstCall).to.have.been.calledWith('Debugger.enable')
      expect(sessionMock.post.secondCall).to.have.been.calledWith('Debugger.setBreakpoint', {
        location: {
          scriptId: 'script-1',
          lineNumber: 9,
          columnNumber: 0
        },
        condition: undefined
      })
    })

    it('should not enable debugger for subsequent breakpoints', async function () {
      // First breakpoint
      await breakpoints.addBreakpoint({
        id: 'probe-1',
        version: 1,
        where: {
          sourceFile: 'test.js',
          lines: ['10']
        }
      })

      sessionMock.post.resetHistory()

      // Second breakpoint
      await breakpoints.addBreakpoint({
        id: 'probe-2',
        version: 1,
        where: {
          sourceFile: 'test2.js',
          lines: ['20']
        }
      })

      expect(sessionMock.post.callCount).to.equal(1)
      expect(sessionMock.post.firstCall).to.have.been.calledWith('Debugger.setBreakpoint')
    })

    describe('add multiple probes to the same location', function () {
      it('no conditions', async function () {
        // Add first probe
        await breakpoints.addBreakpoint({
          id: 'probe-1',
          version: 1,
          where: {
            sourceFile: 'test.js',
            lines: ['10']
          }
        })

        sessionMock.post.resetHistory()

        // Add second probe to same location
        await breakpoints.addBreakpoint({
          id: 'probe-2',
          version: 1,
          where: {
            sourceFile: 'test.js',
            lines: ['10']
          }
        })

        expect(sessionMock.post.callCount).to.equal(0)
      })

      it('mixed: 2nd probe no condition', async function () {
        // Add first probe
        await breakpoints.addBreakpoint({
          id: 'probe-1',
          version: 1,
          when: {
            json: { eq: [{ ref: 'foo' }, 42] },
            dsl: 'foo = 42'
          },
          where: {
            sourceFile: 'test.js',
            lines: ['10']
          }
        })

        // Reset call history
        sessionMock.post.resetHistory()

        // Add second probe to same location
        await breakpoints.addBreakpoint({
          id: 'probe-2',
          version: 1,
          where: {
            sourceFile: 'test.js',
            lines: ['10']
          }
        })

        // Should remove previous breakpoint and create a new one with both conditions
        expect(sessionMock.post.callCount).to.equal(2)
        expect(sessionMock.post.firstCall).to.have.been.calledWith('Debugger.removeBreakpoint', {
          breakpointId: 'bp-script-1:9:0'
        })
        expect(sessionMock.post.secondCall).to.have.been.calledWith('Debugger.setBreakpoint', {
          location: {
            scriptId: 'script-1',
            lineNumber: 9,
            columnNumber: 0
          },
          condition: undefined
        })
      })

      it('mixed: 1st probe no condition', async function () {
        // Add first probe
        await breakpoints.addBreakpoint({
          id: 'probe-1',
          version: 1,
          where: {
            sourceFile: 'test.js',
            lines: ['10']
          }
        })

        // Reset call history
        sessionMock.post.resetHistory()

        // Add second probe to same location
        await breakpoints.addBreakpoint({
          id: 'probe-2',
          version: 1,
          when: {
            json: { eq: [{ ref: 'foo' }, 42] },
            dsl: 'foo = 42'
          },
          where: {
            sourceFile: 'test.js',
            lines: ['10']
          }
        })

        expect(sessionMock.post.callCount).to.equal(0)
      })

      it('all conditions', async function () {
        // Add first probe
        await breakpoints.addBreakpoint({
          id: 'probe-1',
          version: 1,
          when: {
            json: { eq: [{ ref: 'foo' }, 42] },
            dsl: 'foo == 42'
          },
          where: {
            sourceFile: 'test.js',
            lines: ['10']
          }
        })

        // Reset call history
        sessionMock.post.resetHistory()

        // Add second probe to same location
        await breakpoints.addBreakpoint({
          id: 'probe-2',
          version: 1,
          when: {
            json: { eq: [{ ref: 'foo' }, 43] },
            dsl: 'foo == 43'
          },
          where: {
            sourceFile: 'test.js',
            lines: ['10']
          }
        })

        // Should remove previous breakpoint and create a new one with both conditions
        expect(sessionMock.post.callCount).to.equal(2)
        expect(sessionMock.post.firstCall).to.have.been.calledWith('Debugger.removeBreakpoint', {
          breakpointId: 'bp-script-1:9:0'
        })
        expect(sessionMock.post.secondCall).to.have.been.calledWith('Debugger.setBreakpoint', {
          location: {
            scriptId: 'script-1',
            lineNumber: 9,
            columnNumber: 0
          },
          condition: '(foo) === (42) || (foo) === (43)'
        })
      })

      it('should allow adding multiple probes at the same location synchronously', async function () {
        // Test we don't hit a race condition where the internal state isn't updated before we try to add a new probe
        await Promise.all([
          breakpoints.addBreakpoint({
            id: 'probe-1',
            version: 1,
            where: { sourceFile: 'test.js', lines: ['10'] }
          }),
          breakpoints.addBreakpoint({
            id: 'probe-2',
            version: 1,
            where: { sourceFile: 'test.js', lines: ['10'] }
          })
        ])
        expect(sessionMock.post.callCount).to.equal(2)
        expect(sessionMock.post.firstCall).to.have.been.calledWith('Debugger.enable')
        expect(sessionMock.post.secondCall).to.have.been.calledWith('Debugger.setBreakpoint')
      })
    })

    it('should throw error if script not found', async function () {
      stateMock.findScriptFromPartialPath.returns(null)

      const probe = {
        id: 'probe-1',
        version: 1,
        where: {
          sourceFile: 'test.js',
          lines: ['10']
        }
      }

      await breakpoints.addBreakpoint(probe)
        .then(() => {
          throw new Error('Should not resolve')
        })
        .catch((err) => {
          expect(err).to.be.instanceOf(Error)
          expect(err.message).to.equal('No loaded script found for test.js (probe: probe-1, version: 1)')
        })
    })

    it('should handle condition compilation errors', async function () {
      const probe = {
        id: 'probe-1',
        version: 1,
        where: {
          sourceFile: 'test.js',
          lines: ['10']
        },
        when: {
          json: { invalid: 'condition' },
          dsl: 'this is an invalid condition'
        }
      }

      await breakpoints.addBreakpoint(probe)
        .then(() => {
          throw new Error('Should not resolve')
        })
        .catch((err) => {
          expect(err).to.be.instanceOf(Error)
          expect(err.message).to.equal('Cannot compile expression: this is an invalid condition')
        })
    })
  })

  describe('removeBreakpoint', function () {
    it('should disable debugger instead of removing the breakpoint if it is the last breakpoint', async function () {
      await addProbe()
      sessionMock.post.resetHistory()

      await breakpoints.removeBreakpoint({ id: 'probe-1' })

      expect(sessionMock.post.callCount).to.equal(1)
      expect(sessionMock.post).to.have.been.calledWith('Debugger.disable')
    })

    it('should not disable debugger when there are other breakpoints', async function () {
      await addProbe()
      await addProbe({ id: 'probe-2', where: { sourceFile: 'test2.js', lines: ['20'] } })
      sessionMock.post.resetHistory()

      await breakpoints.removeBreakpoint({ id: 'probe-1' })

      expect(sessionMock.post.callCount).to.equal(1)
      expect(sessionMock.post).to.have.been.calledWith('Debugger.removeBreakpoint', { breakpointId: 'bp-script-1:9:0' })
    })

    describe('update breakpoint when removing one of multiple probes at the same location', function () {
      it('no conditions', async function () {
        await addProbe()
        await addProbe({ id: 'probe-2' })
        sessionMock.post.resetHistory()

        await breakpoints.removeBreakpoint({ id: 'probe-1' })

        expect(sessionMock.post.callCount).to.equal(0)
      })

      it('mixed: removed probe with no condition', async function () {
        await addProbe()
        await addProbe({
          id: 'probe-2',
          when: {
            json: { eq: [{ ref: 'foo' }, 42] },
            dsl: 'foo = 42'
          }
        })
        sessionMock.post.resetHistory()

        await breakpoints.removeBreakpoint({ id: 'probe-1' })

        expect(sessionMock.post.callCount).to.equal(2)
        expect(sessionMock.post.firstCall).to.have.been.calledWith('Debugger.removeBreakpoint', {
          breakpointId: 'bp-script-1:9:0'
        })
        expect(sessionMock.post.secondCall).to.have.been.calledWith('Debugger.setBreakpoint', {
          location: {
            scriptId: 'script-1',
            lineNumber: 9,
            columnNumber: 0
          },
          condition: '(foo) === (42)'
        })
      })

      it('mixed: removed probe with condtion', async function () {
        await addProbe({
          when: {
            json: { eq: [{ ref: 'foo' }, 42] },
            dsl: 'foo = 42'
          }
        })
        await addProbe({ id: 'probe-2' })
        sessionMock.post.resetHistory()

        await breakpoints.removeBreakpoint({ id: 'probe-1' })

        expect(sessionMock.post.callCount).to.equal(0)
      })

      it('all conditions', async function () {
        await addProbe({
          when: {
            json: { eq: [{ ref: 'foo' }, 42] },
            dsl: 'foo = 42'
          }
        })
        await addProbe({
          id: 'probe-2',
          when: {
            json: { eq: [{ ref: 'foo' }, 43] },
            dsl: 'foo = 43'
          }
        })
        sessionMock.post.resetHistory()

        await breakpoints.removeBreakpoint({ id: 'probe-1' })

        expect(sessionMock.post.callCount).to.equal(2)
        expect(sessionMock.post.firstCall).to.have.been.calledWith('Debugger.removeBreakpoint', {
          breakpointId: 'bp-script-1:9:0'
        })
        expect(sessionMock.post.secondCall).to.have.been.calledWith('Debugger.setBreakpoint', {
          location: {
            scriptId: 'script-1',
            lineNumber: 9,
            columnNumber: 0
          },
          condition: '(foo) === (43)'
        })
      })
    })

    it('should throw error if debugger not started', async function () {
      await breakpoints.removeBreakpoint({ id: 'probe-1' })
        .then(() => {
          throw new Error('Should not resolve')
        })
        .catch((err) => {
          expect(err).to.be.instanceOf(Error)
          expect(err.message).to.equal('Cannot remove probe probe-1: Debugger not started')
        })
    })

    it('should throw error if probe is unknown', async function () {
      await addProbe()
      await breakpoints.removeBreakpoint({ id: 'unknown-probe' })
        .then(() => {
          throw new Error('Should not resolve')
        })
        .catch((err) => {
          expect(err).to.be.instanceOf(Error)
          expect(err.message).to.equal('Unknown probe id: unknown-probe')
        })
    })
  })

  async function addProbe ({ id, version, where, when } = {}) {
    await breakpoints.addBreakpoint({
      id: id || 'probe-1',
      version: version || 1,
      where: where || {
        sourceFile: 'test.js',
        lines: ['10']
      },
      when
    })
  }
})
