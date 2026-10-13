Feature: Known flaky retries
  Scenario: known flaky failure
    Then the known test fails
  Scenario: new failure
    Then the new test fails
  Scenario: recovers
    Then the test recovers
