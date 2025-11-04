#!/bin/bash

# Script to run tests continuously until they fail
# When it fails, shows full output. When it passes, ignores it.

counter=1

echo "Starting test loop..."
echo "Running: yarn test:appsec:plugins:ci"
echo "-------------------------------------------"

while true; do
    echo -n "Iteration #${counter}... "

    # Run the command and capture output
    output=$(yarn test:appsec:plugins:ci 2>&1)
    exit_code=$?

    if [ $exit_code -ne 0 ]; then
        # Test failed
        echo "❌ FAILED"
        echo ""
        echo "========================================"
        echo "TEST FAILED ON ITERATION #${counter}"
        echo "========================================"
        echo ""
        echo "$output"
        echo ""
        echo "========================================"
        echo "Exiting loop after ${counter} iterations"
        echo "========================================"
        exit $exit_code
    else
        # Test passed
        echo "✓ Passed"
        counter=$((counter + 1))
        sleep 5
    fi
done

