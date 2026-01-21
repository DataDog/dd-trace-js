#!/bin/bash
# Dependency Health Check for dd-trace-js Test Environment
#
# Usage: ./scripts/validate_test_env.sh [integration_name]
#
# Checks for common dependency issues that can break tests:
# - Stale packages in versions/node_modules (cause resolution conflicts)
# - Missing peer dependencies
# - Module resolution issues
# - externals.json configuration problems

set -e

INTEGRATION="${1:-}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "🔍 dd-trace-js Dependency Health Check"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

cd "$REPO_ROOT"

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Counters
WARNINGS=0
ERRORS=0

# Check 1: Stale dependencies in versions/node_modules
echo -e "${BLUE}[1/5] Checking for stale dependencies...${NC}"
if [ -d "versions/node_modules" ]; then
    STALE_COUNT=$(find versions/node_modules -maxdepth 2 -type d 2>/dev/null | wc -l | tr -d ' ')
    if [ "$STALE_COUNT" -gt 100 ]; then
        echo -e "${YELLOW}⚠️  WARNING: Found $STALE_COUNT items in versions/node_modules${NC}"
        echo "   These can cause module resolution conflicts."
        echo "   Recommendation: rm -rf versions/node_modules"
        WARNINGS=$((WARNINGS + 1))
    else
        echo -e "${GREEN}✓ No significant stale dependencies found${NC}"
    fi
else
    echo -e "${GREEN}✓ versions/node_modules does not exist${NC}"
fi
echo ""

# Check 2: Integration-specific checks (if integration provided)
if [ -n "$INTEGRATION" ]; then
    echo -e "${BLUE}[2/5] Checking integration: $INTEGRATION...${NC}"

    # Check if integration package exists
    if [ -d "packages/datadog-plugin-$INTEGRATION" ]; then
        echo -e "${GREEN}✓ Plugin directory exists: packages/datadog-plugin-$INTEGRATION${NC}"
    else
        echo -e "${YELLOW}⚠️  Plugin directory not found: packages/datadog-plugin-$INTEGRATION${NC}"
        WARNINGS=$((WARNINGS + 1))
    fi

    # Check if test file exists
    TEST_FILE="packages/dd-trace/test/llmobs/plugins/$INTEGRATION/index.spec.js"
    if [ -f "$TEST_FILE" ]; then
        echo -e "${GREEN}✓ Test file exists: $TEST_FILE${NC}"
    else
        echo -e "${YELLOW}⚠️  Test file not found: $TEST_FILE${NC}"
        WARNINGS=$((WARNINGS + 1))
    fi

    # Try to load the integration module
    echo "   Testing if integration can be loaded..."
    LOAD_TEST=$(node -e "
        try {
            const pkg = require('@langchain/$INTEGRATION');
            console.log('LOAD_OK');
        } catch (e) {
            console.log('LOAD_ERROR:', e.message);
            process.exit(1);
        }
    " 2>&1 || true)

    if echo "$LOAD_TEST" | grep -q "LOAD_OK"; then
        echo -e "${GREEN}✓ Integration loads successfully${NC}"
    elif echo "$LOAD_TEST" | grep -q "Cannot find module"; then
        echo -e "${RED}✗ ERROR: Integration module not found${NC}"
        echo "   $LOAD_TEST"
        ERRORS=$((ERRORS + 1))
    elif echo "$LOAD_TEST" | grep -q "ERR_PACKAGE_PATH_NOT_EXPORTED"; then
        echo -e "${RED}✗ ERROR: Package export path issue${NC}"
        echo "   $LOAD_TEST"
        ERRORS=$((ERRORS + 1))
    else
        echo -e "${YELLOW}⚠️  WARNING: Unexpected load error${NC}"
        echo "   $LOAD_TEST"
        WARNINGS=$((WARNINGS + 1))
    fi
else
    echo -e "${BLUE}[2/5] Skipping integration checks (no integration specified)${NC}"
fi
echo ""

# Check 3: externals.json configuration
echo -e "${BLUE}[3/5] Checking externals.json configuration...${NC}"
if [ -f "packages/dd-trace/test/plugins/externals.json" ]; then
    echo -e "${GREEN}✓ externals.json exists${NC}"

    if [ -n "$INTEGRATION" ]; then
        # Check if integration is configured
        if grep -q "\"@langchain/$INTEGRATION\"" packages/dd-trace/test/plugins/externals.json; then
            echo -e "${GREEN}✓ Integration '$INTEGRATION' found in externals.json${NC}"

            # Check for peer dependencies
            CONFIG=$(cat packages/dd-trace/test/plugins/externals.json | grep -A 20 "\"@langchain/$INTEGRATION\"" | head -20)
            if echo "$CONFIG" | grep -q '"dep": true'; then
                echo -e "${GREEN}✓ Peer dependencies configured${NC}"
            else
                echo -e "${YELLOW}⚠️  No peer dependencies configured${NC}"
                WARNINGS=$((WARNINGS + 1))
            fi
        else
            echo -e "${YELLOW}⚠️  Integration '$INTEGRATION' not found in externals.json${NC}"
            WARNINGS=$((WARNINGS + 1))
        fi
    fi
else
    echo -e "${RED}✗ ERROR: externals.json not found${NC}"
    ERRORS=$((ERRORS + 1))
fi
echo ""

# Check 4: Version directories consistency
echo -e "${BLUE}[4/5] Checking version directories...${NC}"
if [ -n "$INTEGRATION" ]; then
    INTEGRATION_VERSIONS=$(ls -d versions/@langchain/$INTEGRATION* 2>/dev/null || true)
    if [ -n "$INTEGRATION_VERSIONS" ]; then
        echo -e "${GREEN}✓ Version directories found:${NC}"
        echo "$INTEGRATION_VERSIONS" | sed 's/^/   /'

        # Check each version for proper structure
        for VERSION_DIR in $INTEGRATION_VERSIONS; do
            if [ -d "$VERSION_DIR/node_modules/@langchain/$INTEGRATION" ]; then
                echo -e "${GREEN}   ✓ $(basename $VERSION_DIR) has proper structure${NC}"
            else
                echo -e "${YELLOW}   ⚠️  $(basename $VERSION_DIR) missing integration in node_modules${NC}"
                WARNINGS=$((WARNINGS + 1))
            fi
        done
    else
        echo -e "${YELLOW}⚠️  No version directories found for $INTEGRATION${NC}"
        WARNINGS=$((WARNINGS + 1))
    fi
else
    TOTAL_VERSIONS=$(ls -d versions/@langchain/* 2>/dev/null | wc -l | tr -d ' ')
    echo -e "${GREEN}✓ Found $TOTAL_VERSIONS @langchain version directories${NC}"
fi
echo ""

# Check 5: Node.js version
echo -e "${BLUE}[5/5] Checking Node.js version...${NC}"
NODE_VERSION=$(node --version)
echo "   Node version: $NODE_VERSION"
if [[ "$NODE_VERSION" =~ ^v(18|20|22|25) ]]; then
    echo -e "${GREEN}✓ Node.js version compatible${NC}"
else
    echo -e "${YELLOW}⚠️  Node.js version may be incompatible${NC}"
    echo "   Recommended: v18, v20, v22, or v25"
    WARNINGS=$((WARNINGS + 1))
fi
echo ""

# Summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}Summary:${NC}"
if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo -e "${GREEN}✅ All checks passed! Environment is healthy.${NC}"
    exit 0
elif [ $ERRORS -eq 0 ]; then
    echo -e "${YELLOW}⚠️  $WARNINGS warning(s) found${NC}"
    echo "   Environment should work but may have issues"
    exit 0
else
    echo -e "${RED}✗ $ERRORS error(s) and $WARNINGS warning(s) found${NC}"
    echo "   Environment has problems that will likely cause test failures"
    echo ""
    echo "Common fixes:"
    echo "  1. Clean stale dependencies: rm -rf versions/node_modules"
    echo "  2. Reinstall packages: yarn install"
    echo "  3. Check externals.json configuration"
    exit 1
fi
