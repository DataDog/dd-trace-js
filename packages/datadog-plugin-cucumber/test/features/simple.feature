Feature: Datadog integration

  Scenario: pass scenario
    Given datadog
    When run
    Then pass

  Scenario: fail scenario
    Given datadog
    When run
    Then fail

  Scenario: skip scenario
    Given datadog
    When run
    Then skip

  @skip
  Scenario: skip scenario based on tag
    Given datadog
