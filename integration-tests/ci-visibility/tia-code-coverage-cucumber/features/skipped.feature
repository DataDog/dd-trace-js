Feature: Skipped coverage
  Scenario: Skipped dependency
    When the skipped dependency is covered
    Then the coverage result should be 3
