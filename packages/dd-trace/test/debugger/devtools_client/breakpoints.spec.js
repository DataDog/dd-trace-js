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
      on (event, callback) {
        if (event === 'scriptLoadingStabilized') callback()
      },
      '@noCallThru': true
    }

    stateMock = {
      findScriptFromPartialPath: sinon.stub().returns({
        url: 'file:///path/to/test.js',
        scriptId: 'script-1',
        sourceMapURL: null,
        source: null
      }),
      clearState: sinon.stub(),
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
      await addProbe()

      expect(sessionMock.post.firstCall).to.have.been.calledWith('Debugger.enable')
      expect(sessionMock.post.secondCall).to.have.been.calledWith('Debugger.setBreakpoint', {
        location: {
          scriptId: 'script-1',
          lineNumber: 9,
          columnNumber: 0
        },
        condition: undefined
      })
      expect(sessionMock.post).to.have.been.calledTwice
    })

    it('should not enable debugger for subsequent breakpoints', async function () {
      await addProbe()
      sessionMock.post.resetHistory()

      await addProbe({ id: 'probe-2', where: { sourceFile: 'test2.js', lines: ['20'] } })

      expect(sessionMock.post).to.have.been.calledOnceWith('Debugger.setBreakpoint')
    })

    it('2nd probe should wait until the debugger has finished enabling before being applied', async function () {
      // Not enabling the debugger more than once is easy to test, but testing that the 2nd probe waits for the
      // debugger to be completely enabled before being applied is a lot harder to test. Here we rely on the order of
      // the calls to `stateMock.findScriptFromPartialPath` to be in the same order as the probes are added.

      await Promise.all([
        addProbe(),
        addProbe({ id: 'probe-2', where: { sourceFile: 'test2.js', lines: ['20'] } })
      ])

      expect(sessionMock.post.firstCall).to.have.been.calledWith('Debugger.enable')
      expect(sessionMock.post.secondCall).to.have.been.calledWith('Debugger.setBreakpoint')
      expect(sessionMock.post.thirdCall).to.have.been.calledWith('Debugger.setBreakpoint')
      expect(sessionMock.post).to.have.been.calledThrice

      expect(stateMock.findScriptFromPartialPath.firstCall).to.have.been.calledWith('test.js')
      expect(stateMock.findScriptFromPartialPath.secondCall).to.have.been.calledWith('test2.js')
      expect(stateMock.findScriptFromPartialPath).to.have.been.calledTwice
    })

    describe('add multiple probes to the same location', function () {
      it('no conditions', async function () {
        await addProbe()

        sessionMock.post.resetHistory()

        // Add second probe to same location
        await addProbe({ id: 'probe-2' })

        expect(sessionMock.post).to.not.have.been.called
      })

      it('mixed: 2nd probe no condition', async function () {
        await addProbe({
          when: {
            json: { eq: [{ ref: 'foo' }, 42] },
            dsl: 'foo = 42'
          }
        })
        sessionMock.post.resetHistory()

        // Add second probe to same location
        await addProbe({ id: 'probe-2' })

        // Should remove previous breakpoint and create a new one with both conditions
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
        expect(sessionMock.post).to.have.been.calledTwice
      })

      it('mixed: 1st probe no condition', async function () {
        await addProbe()
        sessionMock.post.resetHistory()

        // Add second probe to same location
        await addProbe({
          id: 'probe-2',
          when: {
            json: { eq: [{ ref: 'foo' }, 42] },
            dsl: 'foo = 42'
          }
        })

        expect(sessionMock.post).to.not.have.been.called
      })

      it('all conditions', async function () {
        await addProbe({
          when: {
            json: { eq: [{ ref: 'foo' }, 42] },
            dsl: 'foo == 42'
          }
        })
        sessionMock.post.resetHistory()

        // Add second probe to same location
        await addProbe({
          id: 'probe-2',
          when: {
            json: { eq: [{ ref: 'foo' }, 43] },
            dsl: 'foo == 43'
          }
        })

        // Should remove previous breakpoint and create a new one with both conditions
        expect(sessionMock.post.firstCall).to.have.been.calledWith('Debugger.removeBreakpoint', {
          breakpointId: 'bp-script-1:9:0'
        })
        expect(sessionMock.post.secondCall).to.have.been.calledWith('Debugger.setBreakpoint', {
          location: {
            scriptId: 'script-1',
            lineNumber: 9,
            columnNumber: 0
          },
          condition:
            '(() => { try { return (foo) === (42) } catch { return false } })() || ' +
            '(() => { try { return (foo) === (43) } catch { return false } })()'
        })
        expect(sessionMock.post).to.have.been.calledTwice
      })

      it('should allow adding multiple probes at the same location synchronously', async function () {
        // Test we don't hit a race condition where the internal state isn't updated before we try to add a new probe
        await Promise.all([
          addProbe(),
          addProbe({ id: 'probe-2' })
        ])
        expect(sessionMock.post.firstCall).to.have.been.calledWith('Debugger.enable')
        expect(sessionMock.post.secondCall).to.have.been.calledWith('Debugger.setBreakpoint')
        expect(sessionMock.post).to.have.been.calledTwice
      })
    })

    it('should throw error if script not found', async function () {
      stateMock.findScriptFromPartialPath.returns(null)

      await addProbe()
        .then(() => {
          throw new Error('Should not resolve')
        })
        .catch((err) => {
          expect(err).to.be.instanceOf(Error)
          expect(err.message).to.equal('No loaded script found for test.js (probe: probe-1, version: 1)')
        })
    })

    it('should handle condition compilation errors', async function () {
      const config = {
        when: {
          json: { invalid: 'condition' },
          dsl: 'this is an invalid condition'
        }
      }

      await addProbe(config)
        .then(() => {
          throw new Error('Should not resolve')
        })
        .catch((err) => {
          expect(err).to.be.instanceOf(Error)
          expect(err.message).to.equal(
            'Cannot compile expression: this is an invalid condition (probe: probe-1, version: 1)'
          )
        })
    })
  })

  describe('removeBreakpoint', function () {
    it('should disable debugger instead of removing the breakpoint if it is the last breakpoint', async function () {
      await addProbe()
      sessionMock.post.resetHistory()

      await breakpoints.removeBreakpoint({ id: 'probe-1' })

      expect(sessionMock.post).to.have.been.calledOnceWith('Debugger.disable')
      expect(stateMock.clearState).to.have.been.calledOnce
    })

    it('should not disable debugger when there are other breakpoints', async function () {
      await addProbe()
      await addProbe({ id: 'probe-2', where: { sourceFile: 'test2.js', lines: ['20'] } })
      sessionMock.post.resetHistory()

      await breakpoints.removeBreakpoint({ id: 'probe-1' })

      expect(sessionMock.post).to.have.been.calledOnceWith(
        'Debugger.removeBreakpoint',
        { breakpointId: 'bp-script-1:9:0' }
      )
      expect(stateMock.clearState).to.not.have.been.called
    })

    it('should wait re-enabling the debugger if it is in the middle of being disabled', async function () {
      await addProbe()
      sessionMock.post.resetHistory()

      await Promise.all([
        breakpoints.removeBreakpoint({ id: 'probe-1' }),
        addProbe({ id: 'probe-2', where: { sourceFile: 'test2.js', lines: ['20'] } })
      ])

      expect(sessionMock.post.firstCall).to.have.been.calledWith('Debugger.disable')
      expect(sessionMock.post.secondCall).to.have.been.calledWith('Debugger.enable')
      expect(sessionMock.post.thirdCall).to.have.been.calledWith('Debugger.setBreakpoint')
      expect(sessionMock.post).to.have.been.calledThrice
    })

    it('should not disable the debugger if a new probe is in the process of being added', async function () {
      await addProbe()

      sessionMock.post.resetHistory()

      await Promise.all([
        addProbe({ id: 'probe-2', where: { sourceFile: 'test2.js', lines: ['20'] } }),
        breakpoints.removeBreakpoint({ id: 'probe-1' })
      ])

      expect(sessionMock.post.firstCall).to.have.been.calledWith('Debugger.setBreakpoint')
      expect(sessionMock.post.secondCall).to.have.been.calledWith('Debugger.removeBreakpoint')
      expect(sessionMock.post).to.have.been.calledTwice
    })

    describe('update breakpoint when removing one of multiple probes at the same location', function () {
      it('no conditions', async function () {
        await addProbe()
        await addProbe({ id: 'probe-2' })
        sessionMock.post.resetHistory()

        await breakpoints.removeBreakpoint({ id: 'probe-1' })

        expect(sessionMock.post).to.not.have.been.called
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
        expect(sessionMock.post).to.have.been.calledTwice
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

        expect(sessionMock.post).to.not.have.been.called
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
        expect(sessionMock.post).to.have.been.calledTwice
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

  describe('modifyBreakpoint', function () {
    it('should re-add the probe when it is the only active probe', async function () {
      await addProbe()
      sessionMock.post.resetHistory()

      // Generate updated config for probe-1
      const probe = genProbeConfig({
        version: 2,
        when: {
          json: { eq: [{ ref: 'foo' }, 42] },
          dsl: 'foo = 42'
        }
      })
      await breakpoints.modifyBreakpoint(probe)

      expect(sessionMock.post.firstCall).to.have.been.calledWith('Debugger.disable')
      expect(sessionMock.post.secondCall).to.have.been.calledWith('Debugger.enable')
      expect(sessionMock.post.thirdCall).to.have.been.calledWith('Debugger.setBreakpoint', {
        location: {
          scriptId: 'script-1',
          lineNumber: 9,
          columnNumber: 0
        },
        condition: '(foo) === (42)'
      })
      expect(sessionMock.post).to.have.been.calledThrice
    })

    it('should re-add the probe when there are other active probes', async function () {
      await addProbe()
      await addProbe({ id: 'probe-2', version: 2, where: { sourceFile: 'test2.js', lines: ['20'] } })
      sessionMock.post.resetHistory()

      // Generate updated config for probe-1
      const probe = genProbeConfig({
        version: 2,
        when: {
          json: { eq: [{ ref: 'foo' }, 42] },
          dsl: 'foo = 42'
        }
      })
      await breakpoints.modifyBreakpoint(probe)

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
      expect(sessionMock.post).to.have.been.calledTwice
    })
  })

  async function addProbe (probe) {
    await breakpoints.addBreakpoint(genProbeConfig(probe))
  }
})

function genProbeConfig ({ id, version, where, when } = {}) {
  return {
    id: id || 'probe-1',
    version: version || 1,
    where: where || { sourceFile: 'test.js', lines: ['10'] },
    when
  }
}
