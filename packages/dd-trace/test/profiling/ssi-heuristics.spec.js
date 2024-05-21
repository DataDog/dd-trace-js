'use strict'

require('../setup/tap')

const expect = require('chai').expect
const sinon = require('sinon')

const telemetryManagerNamespace = sinon.stub()
telemetryManagerNamespace.returns()

const dc = require('dc-polyfill')
const Config = require('../../src/config')

describe('SSI Heuristics', () => {
  it('should be disabled without SSI even if the profiler is manually enabled', () => {
    delete process.env.DD_INJECTION_ENABLED
    process.env.DD_PROFILING_ENABLED = 'true'
    testDisabledHeuristics()
  })

  it('should be disabled when SSI is present but the profiler is manually disabled', () => {
    process.env.DD_INJECTION_ENABLED = 'tracing'
    process.env.DD_PROFILING_ENABLED = 'false'
    testDisabledHeuristics()
  })

  it('should be enabled when SSI is present', () => {
    process.env.DD_INJECTION_ENABLED = 'tracing'
    delete process.env.DD_PROFILING_ENABLED
    return testEnabledHeuristics('not_enabled')
  })

  it('should be enabled when SSI is present and profiling is manually enabled', () => {
    process.env.DD_INJECTION_ENABLED = 'tracing'
    process.env.DD_PROFILING_ENABLED = 'true'
    return testEnabledHeuristics('manually_enabled')
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
  const { SSIHeuristics, EnablementChoice } = proxyquire('../src/profiling/ssi-heuristics', {
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
  return { stubs, SSIHeuristics, EnablementChoice }
}

function testDisabledHeuristics () {
  const { stubs, SSIHeuristics, EnablementChoice } = setupHarness()
  const heuristics = new SSIHeuristics(new Config().profiling)
  heuristics.start()
  dc.channel('dd-trace:span:start').publish()
  dc.channel('datadog:profiling:profile-submitted').publish()
  dc.channel('datadog:profiling:mock-profile-submitted').publish()
  dc.channel('datadog:telemetry:app-closing').publish()
  expect(heuristics.enablementChoice).to.equal(EnablementChoice.DISABLED)
  expect(heuristics.enabled()).to.equal(false)
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
  heuristicDecision,
  longLived = false
) {
  const { stubs, SSIHeuristics } = setupHarness()
  const config = new Config()
  if (longLived) {
    config.profiling.shortLivedThreshold = 2
  }
  const heuristics = new SSIHeuristics(config.profiling)
  heuristics.start()
  expect(heuristics.enabled()).to.equal(true)

  function runScenarioAndCheck () {
    scenario(heuristics)
    createAndCheckMetrics(stubs, profileCount, sentProfiles, enablementChoice, heuristicDecision)
  }

  if (longLived) {
    return new Promise(resolve => setTimeout(resolve, 3)).then(runScenarioAndCheck)
  } else {
    runScenarioAndCheck()
  }
}

function createAndCheckMetrics (stubs, profileCount, sentProfiles, enablementChoice, heuristicDecision) {
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

function testEnabledHeuristics (enablementChoice) {
  testNoOp(enablementChoice)
  testProfilesSent(enablementChoice)
  testMockProfilesSent(enablementChoice)
  testSpan(enablementChoice)
  return testLongLived(enablementChoice).then(() => testTriggered(enablementChoice))
}

function testNoOp (enablementChoice) {
  executeTelemetryEnabledScenario(_ => {}, 0, false, enablementChoice, 'no_span_short_lived')
}

function testProfilesSent (enablementChoice) {
  executeTelemetryEnabledScenario(_ => {
    dc.channel('datadog:profiling:profile-submitted').publish()
    dc.channel('datadog:profiling:profile-submitted').publish()
  }, 2, true, enablementChoice, 'no_span_short_lived')
}

function testMockProfilesSent (enablementChoice) {
  executeTelemetryEnabledScenario(_ => {
    dc.channel('datadog:profiling:mock-profile-submitted').publish()
    dc.channel('datadog:profiling:mock-profile-submitted').publish()
  }, 2, false, enablementChoice, 'no_span_short_lived')
}

function testSpan (enablementChoice) {
  executeTelemetryEnabledScenario(heuristics => {
    dc.channel('dd-trace:span:start').publish()
    expect(heuristics.noSpan).to.equal(false)
    dc.channel('datadog:profiling:profile-submitted').publish()
  }, 1, true, enablementChoice, 'short_lived')
}

function testLongLived (enablementChoice) {
  let callbackInvoked = false
  return executeTelemetryEnabledScenario(heuristics => {
    heuristics.onTriggered(() => {
      callbackInvoked = true
      heuristics.onTriggered()
    })
    dc.channel('datadog:profiling:profile-submitted').publish()
  }, 1, true, enablementChoice, 'no_span', true).then(() => {
    expect(callbackInvoked).to.equal(false)
  })
}

function testTriggered (enablementChoice) {
  let callbackInvoked = false
  return executeTelemetryEnabledScenario(heuristics => {
    heuristics.onTriggered(() => {
      callbackInvoked = true
      heuristics.onTriggered()
    })
    dc.channel('dd-trace:span:start').publish()
    expect(heuristics.noSpan).to.equal(false)
    dc.channel('datadog:profiling:profile-submitted').publish()
  }, 1, true, enablementChoice, 'triggered', true).then(() => {
    expect(callbackInvoked).to.equal(true)
  })
}
