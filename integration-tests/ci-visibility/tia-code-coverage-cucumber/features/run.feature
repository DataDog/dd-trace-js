Feature: Run coverage
  Scenario: Run dependency
    When the run dependency is covered
    Then the coverage result should be 3
