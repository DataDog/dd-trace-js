Feature: Test Suite

  Scenario: Say pass
    When the greeter says pass
    Then I should have heard "pass"

  @skip
  Scenario: Say skip
    When the greeter says pass
    Then I should have heard "pass"

  Scenario: Say fail
    When the greeter says fail
    Then I should have heard "fail"

  Scenario: Say flaky
    When the greeter says flaky
    Then I should have heard "flaky"

  @with-hooks
  Scenario: Say pass with hooks
    When the greeter says pass
    Then I should have heard "pass"

  @with-hooks
  Scenario: Say fail with hooks
    When the greeter says fail
    Then I should have heard "fail"

  @with-hooks
  Scenario: Say flaky with hooks
    When the greeter says flaky with hooks
    Then I should have heard "flaky"
