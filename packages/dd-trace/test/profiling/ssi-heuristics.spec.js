'use strict'

require('../setup/tap')

const expect = require('chai').expect
const sinon = require('sinon')

const telemetryManagerNamespace = sinon.stub()
telemetryManagerNamespace.returns()

const dc = require('dc-polyfill')
const Config = require('../../src/config')

describe('Profiling for SSI', () => {
  describe('When injection is not present', () => {
    describe('Neither telemetry nor heuristics should work when', () => {
      it('profiler enablement is unspecified', () => {
        delete process.env.DD_INJECTION_ENABLED
        testInactive('')
      })

      it('the profiler is explicitly enabled', () => {
        delete process.env.DD_INJECTION_ENABLED
        testInactive('true')
      })

      it('the profiler is explicitly disabled', () => {
        delete process.env.DD_INJECTION_ENABLED
        testInactive('false')
      })
    })

    describe('Only telemetry should work when', () => {
      it('the profiler is explicitly auto-enabled', () => {
        delete process.env.DD_INJECTION_ENABLED
        process.env.DD_PROFILING_ENABLED = 'auto'
        return testEnabledHeuristics(undefined, true)
      })
    })
  })

  describe('When injection is present', () => {
    describe('Neither telemetry nor heuristics should work when', () => {
      it('the profiler is explicitly disabled', () => {
        process.env.DD_INJECTION_ENABLED = 'tracer'
        return testInactive('false')
      })
    })

    describe('Only telemetry should work when', () => {
      it('profiler enablement is unspecified', () => {
        process.env.DD_INJECTION_ENABLED = 'tracer'
        delete process.env.DD_PROFILING_ENABLED
        return testEnabledHeuristics('ssi_not_enabled', false)
      })

      it('the profiler is explicitly enabled', () => {
        process.env.DD_INJECTION_ENABLED = 'tracer'
        process.env.DD_PROFILING_ENABLED = 'true'
        return testEnabledHeuristics('manually_enabled', false)
      })
    })

    describe('Both telemetry and heuristics should work when', () => {
      it('the profiler is explicitly auto-enabled', () => {
        process.env.DD_INJECTION_ENABLED = 'tracer'
        process.env.DD_PROFILING_ENABLED = 'auto'
        return testEnabledHeuristics('auto_enabled', true)
      })

      it('\'profiler\' value is in DD_INJECTION_ENABLED', () => {
        process.env.DD_INJECTION_ENABLED = 'tracer,service_name,profiler'
        return testEnabledHeuristics('ssi_enabled', true)
      })
    })
  })
})

function setupHarness () {
  const profileCountCount = {
    inc: sinon.stub()
  }
  const runtimeIdCount = {
    inc: sinon.stub()
  }
  const ssiMetricsNamespace = {
    count: sinon.stub().callsFake((name, tags) => {
      if (name === 'ssi_heuristic.number_of_profiles') {
        return profileCountCount
      } else if (name === 'ssi_heuristic.number_of_runtime_id') {
        return runtimeIdCount
      }
    })
  }

  const namespaceFn = sinon.stub().returns(ssiMetricsNamespace)
  const { SSIHeuristics } = proxyquire('../src/profiling/ssi-heuristics', {
    '../telemetry/metrics': {
      manager: {
        namespace: namespaceFn
      }
    }
  })
  expect(namespaceFn.calledOnceWithExactly('profilers')).to.equal(true)
  const stubs = {
    profileCountCountInc: profileCountCount.inc,
    runtimeIdCountInc: runtimeIdCount.inc,
    count: ssiMetricsNamespace.count
  }
  return { stubs, SSIHeuristics }
}

function testInactive (profilingEnabledValue) {
  process.env.DD_PROFILING_ENABLED = profilingEnabledValue

  const { stubs, SSIHeuristics } = setupHarness()
  const heuristics = new SSIHeuristics(new Config())
  heuristics.start()
  expect(heuristics.emitsTelemetry).to.equal(false)
  expect(heuristics.heuristicsActive).to.equal(false)

  dc.channel('dd-trace:span:start').publish()
  dc.channel('datadog:profiling:profile-submitted').publish()
  dc.channel('datadog:profiling:mock-profile-submitted').publish()
  dc.channel('datadog:telemetry:app-closing').publish()
  expect(heuristics.enablementChoice).to.equal(undefined)
  // When it is disabled, the telemetry should not subscribe to any channel
  // so the preceding publishes should not have any effect.
  expect(heuristics._profileCount).to.equal(undefined)
  expect(heuristics.hasSentProfiles).to.equal(false)
  expect(heuristics.noSpan).to.equal(true)
  expect(stubs.count.notCalled).to.equal(true)
}

function executeTelemetryEnabledScenario (
  scenario,
  profileCount,
  sentProfiles,
  enablementChoice,
  heuristicsActive,
  heuristicDecision,
  longLived = false
) {
  const { stubs, SSIHeuristics } = setupHarness()
  const config = new Config()
  if (longLived) {
    config.profiling.longLivedThreshold = 2
  }
  const heuristics = new SSIHeuristics(config)
  heuristics.start()
  expect(heuristics.heuristicsActive).to.equal(heuristicsActive)

  function runScenarioAndCheck () {
    scenario(heuristics)
    if (enablementChoice) {
      createAndCheckMetrics(stubs, profileCount, sentProfiles, enablementChoice, heuristicDecision)
    } else {
      // enablementChose being undefined means telemetry should not be active so
      // no metrics APIs must've been called
      expect(stubs.count.args.length).to.equal(0)
      expect(stubs.profileCountCountInc.args.length).to.equal(0)
      expect(stubs.count.args.length).to.equal(0)
      expect(stubs.runtimeIdCountInc.args.length).to.equal(0)
    }
    dc.channel('datadog:telemetry:app-closing').publish()
  }

  if (longLived) {
    return new Promise(resolve => setTimeout(resolve, 3)).then(runScenarioAndCheck)
  } else {
    runScenarioAndCheck()
  }
}

function createAndCheckMetrics (
  stubs,
  profileCount,
  sentProfiles,
  enablementChoice,
  heuristicDecision
) {
  // Trigger metrics creation
  dc.channel('datadog:telemetry:app-closing').publish()

  const tags = [
    'installation:ssi',
    `enablement_choice:${enablementChoice}`,
    `has_sent_profiles:${sentProfiles}`,
    `heuristic_hypothetical_decision:${heuristicDecision}`
  ]
  expect(stubs.count.calledWith('ssi_heuristic.number_of_profiles', tags)).to.equal(true)
  expect(stubs.profileCountCountInc.args.length).to.equal(profileCount + 1) // once at the end with 0
  expect(stubs.count.calledWith('ssi_heuristic.number_of_runtime_id', tags)).to.equal(true)
  expect(stubs.runtimeIdCountInc.args.length).to.equal(1)
}

function testEnabledHeuristics (enablementChoice, heuristicsEnabled) {
  testNoOp(enablementChoice, heuristicsEnabled)
  testProfilesSent(enablementChoice, heuristicsEnabled)
  testMockProfilesSent(enablementChoice, heuristicsEnabled)
  testSpan(enablementChoice, heuristicsEnabled)
  return testLongLived(enablementChoice, heuristicsEnabled).then(
    () => testTriggered(enablementChoice, heuristicsEnabled)
  )
}

function testNoOp (enablementChoice, heuristicsActive) {
  executeTelemetryEnabledScenario(_ => {}, 0, false, enablementChoice, heuristicsActive, 'no_span_short_lived')
}

function testProfilesSent (enablementChoice, heuristicsActive) {
  executeTelemetryEnabledScenario(_ => {
    dc.channel('datadog:profiling:profile-submitted').publish()
    dc.channel('datadog:profiling:profile-submitted').publish()
  }, 2, true, enablementChoice, heuristicsActive, 'no_span_short_lived')
}

function testMockProfilesSent (enablementChoice, heuristicsActive) {
  executeTelemetryEnabledScenario(_ => {
    dc.channel('datadog:profiling:mock-profile-submitted').publish()
    dc.channel('datadog:profiling:mock-profile-submitted').publish()
  }, 2, false, enablementChoice, heuristicsActive, 'no_span_short_lived')
}

function testSpan (enablementChoice, heuristicsActive) {
  executeTelemetryEnabledScenario(heuristics => {
    const ch = dc.channel('dd-trace:span:start')
    expect(ch.hasSubscribers).to.equal(true)
    ch.publish()
    expect(heuristics.noSpan).to.equal(false)
    dc.channel('datadog:profiling:profile-submitted').publish()
  }, 1, true, enablementChoice, heuristicsActive, 'short_lived')
}

function testLongLived (enablementChoice, heuristicsActive) {
  let callbackInvoked = false
  return executeTelemetryEnabledScenario(heuristics => {
    heuristics.onTriggered(() => {
      callbackInvoked = true
      heuristics.onTriggered()
    })
    dc.channel('datadog:profiling:profile-submitted').publish()
  }, 1, true, enablementChoice, heuristicsActive, 'no_span', true).then(() => {
    expect(callbackInvoked).to.equal(false)
  })
}

function testTriggered (enablementChoice, heuristicsActive) {
  let callbackInvoked = false
  return executeTelemetryEnabledScenario(heuristics => {
    heuristics.onTriggered(() => {
      callbackInvoked = true
      heuristics.onTriggered()
    })
    dc.channel('dd-trace:span:start').publish()
    expect(heuristics.noSpan).to.equal(false)
    dc.channel('datadog:profiling:profile-submitted').publish()
  }, 1, true, enablementChoice, heuristicsActive, 'triggered', true).then(() => {
    expect(callbackInvoked).to.equal(true)
  })
}
