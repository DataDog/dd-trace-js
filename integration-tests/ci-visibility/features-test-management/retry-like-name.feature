Feature: Retry-like scenario name
  Scenario: Say quarantine (attempt 2)
    When the greeter says quarantine
    Then I should have heard "quarantine"
