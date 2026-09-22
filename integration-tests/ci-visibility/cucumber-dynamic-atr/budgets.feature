Feature: Duration-based retry budgets
  Scenario Outline: duration <duration>
    Given the first attempt takes <duration> ms and fails 99 times

    Examples:
      | duration |
      | 0        |
      | 4999     |
      | 5000     |
      | 5001     |
      | 10000    |
      | 10001    |
      | 30000    |
      | 30001    |
      | 300000   |
      | 300001   |
