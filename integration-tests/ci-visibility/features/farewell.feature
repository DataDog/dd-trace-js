Feature: Farewell
  Scenario: Say farewell
    When the greeter says farewell
    Then I should have heard "farewell"
  Scenario: Say whatever
    When the greeter says whatever
    Then I should have heard "whatever"
