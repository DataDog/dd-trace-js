Feature: Retry outcomes
  Scenario: recovers
    Given the first attempt takes 5001 ms and fails 2 times

  Scenario: passes
    Given the first attempt takes 0 ms and fails 0 times

  Scenario: skips
    Given the scenario is skipped
