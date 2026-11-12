Feature: Impacted Rule Background DataTable
  Rule: The changed rule
    Background: The greeter has spoken
      When the greeter says impacted test with an argument
        | message  | original |

    Scenario: Scenario inside the changed rule
      Then I should have heard "impacted test"

  Rule: The unchanged rule
    Scenario: Scenario inside the unchanged rule
      When the greeter says impacted test
      Then I should have heard "impacted test"
