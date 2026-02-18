#!/bin/bash

# Test runner for all three logger transport injection implementations
#
# Usage:
#   From this directory: ./run-transport-tests.sh
#   From repo root: ./integration-tests/network-transport-injection/run-transport-tests.sh
#
# Prerequisites:
# 1. Start intake server in another terminal:
#    node integration-tests/network-transport-injection/test-intake-server.js
# 2. Logger dependencies will be checked and installed if needed

set -e

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Change to repo root for npm commands
cd "$REPO_ROOT"

# Check and install logger dependencies if needed
echo "Checking logger dependencies..."
if ! npm list winston bunyan pino pino-pretty &>/dev/null; then
    echo "Installing logger packages (winston, bunyan, pino, pino-pretty)..."
    npm install --no-save winston bunyan pino pino-pretty
    echo "✓ Dependencies installed"
else
    echo "✓ All dependencies present"
fi
echo ""

# Change back to script directory to run tests
cd "$SCRIPT_DIR"

echo "=============================================="
echo "  Logger Transport Injection Test Suite"
echo "=============================================="
echo ""

# Check if intake server is running
echo "Checking if intake server is running on port 8080..."
if ! nc -z localhost 8080 2>/dev/null; then
    echo "⚠️  WARNING: Intake server not detected on port 8080"
    echo "   Start it with: node integration-tests/network-transport-injection/test-intake-server.js"
    echo "   Or from this directory: node test-intake-server.js"
    echo ""
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    echo "✓ Intake server is running"
fi

echo ""
echo "=============================================="
echo "  Test 1/3: Winston Transport Injection"
echo "=============================================="
node test-winston-transport.js

echo ""
echo "=============================================="
echo "  Test 2/3: Bunyan Stream Injection"
echo "=============================================="
node test-bunyan-transport.js

echo ""
echo "=============================================="
echo "  Test 3/4: Pino Simple (No User Transport)"
echo "=============================================="
node test-pino-simple.js

echo ""
echo "=============================================="
echo "  Test 4/4: Pino with pino-pretty"
echo "=============================================="
node test-pino-transport.js

echo ""
echo "=============================================="
echo "  All Tests Complete!"
echo "=============================================="
echo ""
echo "Check the intake server output to verify:"
echo "  ✓ All 20 logs received (5 per test × 4 tests)"
echo "  ✓ Trace correlation present (trace_id, span_id)"
echo "  ✓ Service metadata included (service, env, version)"
echo ""
echo "Test coverage:"
echo "  ✓ Winston: Native HTTP transport"
echo "  ✓ Bunyan: Custom stream with timing fix"
echo "  ✓ Pino Simple: Basic HTTP injection"
echo "  ✓ Pino Pretty: Multistream auto-combination"
echo ""
