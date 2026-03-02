'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { assertObjectContains } = require('../../../../../integration-tests/helpers')
require('../../setup/mocha')

describe('breakpoints', function () {
  /** @type {typeof import('../../../src/debugger/devtools_client/breakpoints')} */
  let breakpoints
  /**
   * @type {{
   *   post: sinon.SinonStub;
   *   on: Function;
   *   '@noCallThru': boolean;
   * }}
   */
  let sessionMock
  /**
   * @type {{
   *   findScriptFromPartialPath: sinon.SinonStub;
   *   clearState: sinon.SinonStub;
   *   locationToBreakpoint: Map<string, {
   *     id: string;
   *     location: { scriptId: string; lineNumber: number; columnNumber: number };
   *     locationKey: string;
   *   }>;
   *   breakpointToProbes: Map<string, Map<string, {
   *     id: string;
   *     version: number;
   *     where: { sourceFile: string; lines: string[] };
   *     when: { json: { eq: [{ ref: string; value: unknown }]; dsl: string }; dsl: string };
   *     sampling?: { snapshotsPerSecond: number };
   *     captureSnapshot: boolean;
   *     capture?: import('../../../src/debugger/devtools_client/snapshot').CaptureLimits;
   *     location: { file: string; lines: string[] };
   *     templateRequiresEvaluation: boolean;
   *     template: string;
   *     lastCaptureNs: bigint;
   *     nsBetweenSampling: bigint;
   *     compiledCaptureExpressions?:
   *       import('../../../src/debugger/devtools_client/snapshot').CompiledCaptureExpression[];
   *   }>>;
   *   probeToLocation: Map<string, string>;
   *   '@noCallThru': boolean;
   * }}
   */
  let stateMock

  const breakpointId = 'bp-script-1:9:0'

  beforeEach(function () {
    sessionMock = {
      post: sinon.stub().callsFake((method, { location } = {}) => {
        if (method === 'Debugger.setBreakpoint') {
          return Promise.resolve({
            breakpointId: `bp-${location.scriptId}:${location.lineNumber}:${location.columnNumber}`,
          })
        }
        return Promise.resolve({})
      }),
      on (event, callback) {
        if (event === 'scriptLoadingStabilized') callback()
      },
      '@noCallThru': true,
    }

    stateMock = {
      findScriptFromPartialPath: sinon.stub().returns({
        url: 'file:///path/to/test.js',
        scriptId: 'script-1',
        sourceMapURL: null,
        source: null,
      }),
      clearState: sinon.stub(),
      locationToBreakpoint: new Map(),
      breakpointToProbes: new Map(),
      probeToLocation: new Map(),
      '@noCallThru': true,
    }

    breakpoints = proxyquire('../../../src/debugger/devtools_client/breakpoints', {
      './session': sessionMock,
      './state': stateMock,
    })
  })

  describe('addBreakpoint', function () {
    it('should enable debugger for the first breakpoint', async function () {
      await addProbe()

      sinon.assert.calledWith(sessionMock.post.firstCall, 'Debugger.enable')
      sinon.assert.calledWith(sessionMock.post.secondCall, 'Debugger.setBreakpoint', {
        location: {
          scriptId: 'script-1',
          lineNumber: 9,
          columnNumber: 0,
        },
        condition: undefined,
      })
      sinon.assert.calledTwice(sessionMock.post)
    })

    it('should not enable debugger for subsequent breakpoints', async function () {
      await addProbe()
      sessionMock.post.resetHistory()

      await addProbe({ id: 'probe-2', where: { sourceFile: 'test2.js', lines: ['20'] } })

      sinon.assert.calledOnceWithMatch(sessionMock.post, 'Debugger.setBreakpoint')
    })

    it('2nd probe should wait until the debugger has finished enabling before being applied', async function () {
      // Not enabling the debugger more than once is easy to test, but testing that the 2nd probe waits for the
      // debugger to be completely enabled before being applied is a lot harder to test. Here we rely on the order of
      // the calls to `stateMock.findScriptFromPartialPath` to be in the same order as the probes are added.

      await Promise.all([
        addProbe(),
        addProbe({ id: 'probe-2', where: { sourceFile: 'test2.js', lines: ['20'] } }),
      ])

      sinon.assert.calledWith(sessionMock.post.firstCall, 'Debugger.enable')
      sinon.assert.calledWith(sessionMock.post.secondCall, 'Debugger.setBreakpoint')
      sinon.assert.calledWith(sessionMock.post.thirdCall, 'Debugger.setBreakpoint')
      sinon.assert.calledThrice(sessionMock.post)

      sinon.assert.calledWith(stateMock.findScriptFromPartialPath.firstCall, 'test.js')
      sinon.assert.calledWith(stateMock.findScriptFromPartialPath.secondCall, 'test2.js')
      sinon.assert.calledTwice(stateMock.findScriptFromPartialPath)
    })

    it('should initialize lastCaptureNs to ensure first probe hit is always captured', async function () {
      await addProbe({ sampling: { snapshotsPerSecond: 0.5 } })

      // Verify the probe was stored in the breakpointToProbes map
      const probesAtLocation = stateMock.breakpointToProbes.get(breakpointId)
      assert(probesAtLocation, 'Probes should be stored at breakpoint location')

      const probe = probesAtLocation.get('probe-1')
      assert(probe, 'Probe should be stored in map')

      // Verify lastCaptureNs is initialized to -(2^53 - 1) to ensure first hit is always captured
      assert.strictEqual(probe.lastCaptureNs, BigInt(Number.MIN_SAFE_INTEGER),
        'lastCaptureNs should be initialized to -(2^53 - 1) to ensure first probe hit is always captured')

      // Verify nsBetweenSampling is calculated correctly
      assert.strictEqual(
        probe.nsBetweenSampling,
        2000000000n,
        'nsBetweenSampling should be 2 seconds for 0.5 samples/second'
      )
    })

    describe('capture limits', function () {
      it('should set default capture limits when captureSnapshot is true', async function () {
        await addProbe({ captureSnapshot: true })

        const probesAtLocation = stateMock.breakpointToProbes.get(breakpointId)
        assert(probesAtLocation, 'Probes should be stored at breakpoint location')

        const probe = probesAtLocation.get('probe-1')
        assert(probe, 'Probe should be stored in map')

        assert.deepStrictEqual(probe.capture, {
          maxReferenceDepth: 3,
          maxCollectionSize: 100,
          maxFieldCount: 20,
          maxLength: 255,
        })
      })

      it('should preserve custom maxReferenceDepth and use defaults for others', async function () {
        await addProbe({
          captureSnapshot: true,
          capture: {
            maxReferenceDepth: 5,
          },
        })

        const probesAtLocation = stateMock.breakpointToProbes.get(breakpointId)
        assert(probesAtLocation, 'Probes should be stored at breakpoint location')

        const probe = probesAtLocation.get('probe-1')
        assert(probe, 'Probe should be stored in map')

        assert.deepStrictEqual(probe.capture, {
          maxReferenceDepth: 5,
          maxCollectionSize: 100,
          maxFieldCount: 20,
          maxLength: 255,
        })
      })

      it('should preserve custom maxCollectionSize and use defaults for others', async function () {
        await addProbe({
          captureSnapshot: true,
          capture: {
            maxCollectionSize: 50,
          },
        })

        const probesAtLocation = stateMock.breakpointToProbes.get(breakpointId)
        assert(probesAtLocation, 'Probes should be stored at breakpoint location')

        const probe = probesAtLocation.get('probe-1')
        assert(probe, 'Probe should be stored in map')

        assert.deepStrictEqual(probe.capture, {
          maxReferenceDepth: 3,
          maxCollectionSize: 50,
          maxFieldCount: 20,
          maxLength: 255,
        })
      })

      it('should preserve custom maxFieldCount and use defaults for others', async function () {
        await addProbe({
          captureSnapshot: true,
          capture: {
            maxFieldCount: 10,
          },
        })

        const probesAtLocation = stateMock.breakpointToProbes.get(breakpointId)
        assert(probesAtLocation, 'Probes should be stored at breakpoint location')

        const probe = probesAtLocation.get('probe-1')
        assert(probe, 'Probe should be stored in map')

        assert.deepStrictEqual(probe.capture, {
          maxReferenceDepth: 3,
          maxCollectionSize: 100,
          maxFieldCount: 10,
          maxLength: 255,
        })
      })

      it('should preserve custom maxLength and use defaults for others', async function () {
        await addProbe({
          captureSnapshot: true,
          capture: {
            maxLength: 128,
          },
        })

        const probesAtLocation = stateMock.breakpointToProbes.get(breakpointId)
        assert(probesAtLocation, 'Probes should be stored at breakpoint location')

        const probe = probesAtLocation.get('probe-1')
        assert(probe, 'Probe should be stored in map')

        assert.deepStrictEqual(probe.capture, {
          maxReferenceDepth: 3,
          maxCollectionSize: 100,
          maxFieldCount: 20,
          maxLength: 128,
        })
      })

      it('should not set capture limits when captureSnapshot is false', async function () {
        await addProbe({ captureSnapshot: false })

        const probesAtLocation = stateMock.breakpointToProbes.get(breakpointId)
        assert(probesAtLocation, 'Probes should be stored at breakpoint location')

        const probe = probesAtLocation.get('probe-1')
        assert(probe, 'Probe should be stored in map')

        assert.strictEqual(probe.capture, undefined)
      })

      it('should not set capture limits when captureSnapshot is undefined', async function () {
        await addProbe()

        const probesAtLocation = stateMock.breakpointToProbes.get(breakpointId)
        assert(probesAtLocation, 'Probes should be stored at breakpoint location')

        const probe = probesAtLocation.get('probe-1')
        assert(probe, 'Probe should be stored in map')

        assert.strictEqual(probe.capture, undefined)
      })
    })

    describe('add multiple probes to the same location', function () {
      it('no conditions', async function () {
        await addProbe()

        sessionMock.post.resetHistory()

        // Add second probe to same location
        await addProbe({ id: 'probe-2' })

        sinon.assert.notCalled(sessionMock.post)
      })

      it('mixed: 2nd probe no condition', async function () {
        await addProbe({
          when: {
            json: { eq: [{ ref: 'foo' }, 42] },
            dsl: 'foo = 42',
          },
        })
        sessionMock.post.resetHistory()

        // Add second probe to same location
        await addProbe({ id: 'probe-2' })

        // Should remove previous breakpoint and create a new one with both conditions
        sinon.assert.calledWith(sessionMock.post.firstCall, 'Debugger.removeBreakpoint', { breakpointId })
        sinon.assert.calledWith(sessionMock.post.secondCall, 'Debugger.setBreakpoint', {
          location: {
            scriptId: 'script-1',
            lineNumber: 9,
            columnNumber: 0,
          },
          condition: undefined,
        })
        sinon.assert.calledTwice(sessionMock.post)
      })

      it('mixed: 1st probe no condition', async function () {
        await addProbe()
        sessionMock.post.resetHistory()

        // Add second probe to same location
        await addProbe({
          id: 'probe-2',
          when: {
            json: { eq: [{ ref: 'foo' }, 42] },
            dsl: 'foo = 42',
          },
        })

        sinon.assert.notCalled(sessionMock.post)
      })

      it('all conditions', async function () {
        await addProbe({
          when: {
            json: { eq: [{ ref: 'foo' }, 42] },
            dsl: 'foo == 42',
          },
        })
        sessionMock.post.resetHistory()

        // Add second probe to same location
        await addProbe({
          id: 'probe-2',
          when: {
            json: { eq: [{ ref: 'foo' }, 43] },
            dsl: 'foo == 43',
          },
        })

        // Should remove previous breakpoint and create a new one with both conditions
        sinon.assert.calledWith(sessionMock.post.firstCall, 'Debugger.removeBreakpoint', { breakpointId })
        sinon.assert.calledWith(sessionMock.post.secondCall, 'Debugger.setBreakpoint', {
          location: {
            scriptId: 'script-1',
            lineNumber: 9,
            columnNumber: 0,
          },
          condition:
            '(() => { try { return (foo) === (42) } catch { return false } })() || ' +
            '(() => { try { return (foo) === (43) } catch { return false } })()',
        })
        sinon.assert.calledTwice(sessionMock.post)
      })

      it('should allow adding multiple probes at the same location synchronously', async function () {
        // Test we don't hit a race condition where the internal state isn't updated before we try to add a new probe
        await Promise.all([
          addProbe(),
          addProbe({ id: 'probe-2' }),
        ])
        sinon.assert.calledWith(sessionMock.post.firstCall, 'Debugger.enable')
        sinon.assert.calledWith(sessionMock.post.secondCall, 'Debugger.setBreakpoint')
        sinon.assert.calledTwice(sessionMock.post)
      })
    })

    it('should throw error if script not found', async function () {
      stateMock.findScriptFromPartialPath.returns(null)

      await addProbe()
        .then(() => {
          throw new Error('Should not resolve')
        })
        .catch((err) => {
          assert.ok(err instanceof Error)
          assert.strictEqual(err.message, 'No loaded script found for test.js (probe: probe-1, version: 1)')
        })
    })

    it('should handle condition compilation errors', async function () {
      const config = {
        when: {
          json: { invalid: 'condition' },
          dsl: 'this is an invalid condition',
        },
      }

      await addProbe(config)
        .then(() => {
          throw new Error('Should not resolve')
        })
        .catch((err) => {
          assert.ok(err instanceof Error)
          assert.strictEqual(err.message,
            'Cannot compile expression: this is an invalid condition (probe: probe-1, version: 1)'
          )
        })
    })

    describe('captureExpressions', function () {
      it('should compile capture expressions', async function () {
        await addProbe({
          captureExpressions: [
            { name: 'myVar', expr: { dsl: 'myVar', json: { ref: 'myVar' } } },
            { name: 'obj.foo', expr: { dsl: 'myObj.myProp', json: { getmember: [{ ref: 'myObj' }, 'myProp'] } } },
          ],
        })

        const probesAtLocation = stateMock.breakpointToProbes.get(breakpointId)

        assert.ok(probesAtLocation, 'could not find probes at location')

        const probe = probesAtLocation.get('probe-1')

        assert.ok(probe, 'could not find probe')
        assert.ok(probe.compiledCaptureExpressions, 'compiledCaptureExpressions should be present')

        assert.strictEqual(probe.compiledCaptureExpressions.length, 2)
        assertObjectContains(probe.compiledCaptureExpressions, [
          { name: 'myVar', expression: 'myVar' },
          { name: 'obj.foo' },
        ])
        assert.ok(probe.compiledCaptureExpressions[1].expression.includes('myObj'))
        assert.ok(probe.compiledCaptureExpressions[1].expression.includes('myProp'))
      })

      it('should store per-expression capture limits', async function () {
        await addProbe({
          captureExpressions: [
            { name: 'a', expr: { dsl: 'a', json: { ref: 'a' } } },
            { name: 'b', expr: { dsl: 'b', json: { ref: 'b' } }, capture: {} },
            { name: 'c', expr: { dsl: 'c', json: { ref: 'c' } }, capture: { maxReferenceDepth: 1 } },
            {
              name: 'd',
              expr: { dsl: 'd', json: { ref: 'd' } },
              capture: { maxReferenceDepth: 1, maxCollectionSize: 2, maxFieldCount: 3, maxLength: 4 },
            },
          ],
        })

        const probesAtLocation = stateMock.breakpointToProbes.get(breakpointId)

        assert.ok(probesAtLocation, 'could not find probes at location')

        const probe = probesAtLocation.get('probe-1')

        assert.ok(probe, 'could not find probe')
        assert.deepStrictEqual(probe.compiledCaptureExpressions, [
          {
            name: 'a',
            expression: 'a',
            limits: { maxReferenceDepth: 3, maxCollectionSize: 100, maxFieldCount: 20, maxLength: 255 },
          },
          {
            name: 'b',
            expression: 'b',
            limits: { maxReferenceDepth: 3, maxCollectionSize: 100, maxFieldCount: 20, maxLength: 255 },
          },
          {
            name: 'c',
            expression: 'c',
            limits: { maxReferenceDepth: 1, maxCollectionSize: 100, maxFieldCount: 20, maxLength: 255 },
          },
          {
            name: 'd',
            expression: 'd',
            limits: { maxReferenceDepth: 1, maxCollectionSize: 2, maxFieldCount: 3, maxLength: 4 },
          },
        ])
      })

      it('should handle capture expression compilation errors', async function () {
        await assert.rejects(
          addProbe({
            captureExpressions: [
              {
                name: 'invalid expr',
                expr: { dsl: 'not a valid identifier!', json: { ref: 'not a valid identifier!' } },
              },
            ],
          }),
          {
            message: 'Cannot compile capture expression: invalid expr (probe: probe-1, version: 1)',
          }
        )
      })

      it('should not set compiledCaptureExpressions if captureExpressions is empty', async function () {
        await addProbe({
          captureExpressions: [],
        })

        const probesAtLocation = stateMock.breakpointToProbes.get(breakpointId)
        assert.ok(probesAtLocation, 'could not find probes at location')

        const probe = probesAtLocation.get('probe-1')
        assert.ok(probe, 'could not find probe')

        assert.strictEqual(probe.compiledCaptureExpressions, undefined)
      })
    })
  })

  describe('removeBreakpoint', function () {
    it('should disable debugger instead of removing the breakpoint if it is the last breakpoint', async function () {
      await addProbe()
      sessionMock.post.resetHistory()

      await breakpoints.removeBreakpoint({ id: 'probe-1' })

      sinon.assert.calledOnceWithExactly(sessionMock.post, 'Debugger.disable')
      sinon.assert.calledOnce(stateMock.clearState)
    })

    it('should not disable debugger when there are other breakpoints', async function () {
      await addProbe()
      await addProbe({ id: 'probe-2', where: { sourceFile: 'test2.js', lines: ['20'] } })
      sessionMock.post.resetHistory()

      await breakpoints.removeBreakpoint({ id: 'probe-1' })

      sinon.assert.calledOnceWithExactly(sessionMock.post,
        'Debugger.removeBreakpoint',
        { breakpointId }
      )
      sinon.assert.notCalled(stateMock.clearState)
    })

    it('should wait re-enabling the debugger if it is in the middle of being disabled', async function () {
      await addProbe()
      sessionMock.post.resetHistory()

      await Promise.all([
        breakpoints.removeBreakpoint({ id: 'probe-1' }),
        addProbe({ id: 'probe-2', where: { sourceFile: 'test2.js', lines: ['20'] } }),
      ])

      sinon.assert.calledWith(sessionMock.post.firstCall, 'Debugger.disable')
      sinon.assert.calledWith(sessionMock.post.secondCall, 'Debugger.enable')
      sinon.assert.calledWith(sessionMock.post.thirdCall, 'Debugger.setBreakpoint')
      sinon.assert.calledThrice(sessionMock.post)
    })

    it('should not disable the debugger if a new probe is in the process of being added', async function () {
      await addProbe()

      sessionMock.post.resetHistory()

      await Promise.all([
        addProbe({ id: 'probe-2', where: { sourceFile: 'test2.js', lines: ['20'] } }),
        breakpoints.removeBreakpoint({ id: 'probe-1' }),
      ])

      sinon.assert.calledWith(sessionMock.post.firstCall, 'Debugger.setBreakpoint')
      sinon.assert.calledWith(sessionMock.post.secondCall, 'Debugger.removeBreakpoint')
      sinon.assert.calledTwice(sessionMock.post)
    })

    describe('update breakpoint when removing one of multiple probes at the same location', function () {
      it('no conditions', async function () {
        await addProbe()
        await addProbe({ id: 'probe-2' })
        sessionMock.post.resetHistory()

        await breakpoints.removeBreakpoint({ id: 'probe-1' })

        sinon.assert.notCalled(sessionMock.post)
      })

      it('mixed: removed probe with no condition', async function () {
        await addProbe()
        await addProbe({
          id: 'probe-2',
          when: {
            json: { eq: [{ ref: 'foo' }, 42] },
            dsl: 'foo = 42',
          },
        })
        sessionMock.post.resetHistory()

        await breakpoints.removeBreakpoint({ id: 'probe-1' })

        sinon.assert.calledWith(sessionMock.post.firstCall, 'Debugger.removeBreakpoint', { breakpointId })
        sinon.assert.calledWith(sessionMock.post.secondCall, 'Debugger.setBreakpoint', {
          location: {
            scriptId: 'script-1',
            lineNumber: 9,
            columnNumber: 0,
          },
          condition: '(foo) === (42)',
        })
        sinon.assert.calledTwice(sessionMock.post)
      })

      it('mixed: removed probe with condition', async function () {
        await addProbe({
          when: {
            json: { eq: [{ ref: 'foo' }, 42] },
            dsl: 'foo = 42',
          },
        })
        await addProbe({ id: 'probe-2' })
        sessionMock.post.resetHistory()

        await breakpoints.removeBreakpoint({ id: 'probe-1' })

        sinon.assert.notCalled(sessionMock.post)
      })

      it('all conditions', async function () {
        await addProbe({
          when: {
            json: { eq: [{ ref: 'foo' }, 42] },
            dsl: 'foo = 42',
          },
        })
        await addProbe({
          id: 'probe-2',
          when: {
            json: { eq: [{ ref: 'foo' }, 43] },
            dsl: 'foo = 43',
          },
        })
        sessionMock.post.resetHistory()

        await breakpoints.removeBreakpoint({ id: 'probe-1' })

        sinon.assert.calledWith(sessionMock.post.firstCall, 'Debugger.removeBreakpoint', { breakpointId })
        sinon.assert.calledWith(sessionMock.post.secondCall, 'Debugger.setBreakpoint', {
          location: {
            scriptId: 'script-1',
            lineNumber: 9,
            columnNumber: 0,
          },
          condition: '(foo) === (43)',
        })
        sinon.assert.calledTwice(sessionMock.post)
      })
    })

    it('should throw error if debugger not started', async function () {
      await breakpoints.removeBreakpoint({ id: 'probe-1' })
        .then(() => {
          throw new Error('Should not resolve')
        })
        .catch((err) => {
          assert.ok(err instanceof Error)
          assert.strictEqual(err.message, 'Cannot remove probe probe-1: Debugger not started')
        })
    })

    it('should throw error if probe is unknown', async function () {
      await addProbe()
      await breakpoints.removeBreakpoint({ id: 'unknown-probe' })
        .then(() => {
          throw new Error('Should not resolve')
        })
        .catch((err) => {
          assert.ok(err instanceof Error)
          assert.strictEqual(err.message, 'Unknown probe id: unknown-probe')
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
          dsl: 'foo = 42',
        },
      })
      await breakpoints.modifyBreakpoint(probe)

      sinon.assert.calledWith(sessionMock.post.firstCall, 'Debugger.disable')
      sinon.assert.calledWith(sessionMock.post.secondCall, 'Debugger.enable')
      sinon.assert.calledWith(sessionMock.post.thirdCall, 'Debugger.setBreakpoint', {
        location: {
          scriptId: 'script-1',
          lineNumber: 9,
          columnNumber: 0,
        },
        condition: '(foo) === (42)',
      })
      sinon.assert.calledThrice(sessionMock.post)
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
          dsl: 'foo = 42',
        },
      })
      await breakpoints.modifyBreakpoint(probe)

      sinon.assert.calledWith(sessionMock.post.firstCall, 'Debugger.removeBreakpoint', { breakpointId })
      sinon.assert.calledWith(sessionMock.post.secondCall, 'Debugger.setBreakpoint', {
        location: {
          scriptId: 'script-1',
          lineNumber: 9,
          columnNumber: 0,
        },
        condition: '(foo) === (42)',
      })
      sinon.assert.calledTwice(sessionMock.post)
    })
  })

  async function addProbe (probe) {
    await breakpoints.addBreakpoint(genProbeConfig(probe))
  }
})

/**
 * Generate a probe config
 *
 * @param {object} [config] Optional configuration object.
 * @param {string} [config.id='probe-1'] The probe ID.
 * @param {number} [config.version=1] The probe version.
 * @param {object} [config.where = { sourceFile: 'test.js', lines: ['10'] }] The location information.
 * @param {object} [config.when] The condition for the probe.
 *   { json: { eq: [{ ref: 'foo' }, 42] }, dsl: 'foo = 42' } by default.
 * @returns {{ id: string; version: number; where: object; when: object; }}
 */
function genProbeConfig ({ id, version, where, when, ...rest } = {}) {
  return {
    id: id || 'probe-1',
    version: version || 1,
    where: where || { sourceFile: 'test.js', lines: ['10'] },
    when,
    ...rest,
  }
}
