#!/usr/bin/env sh

# This script runs all the build scripts in the current directory

set -e  # Exit on any error

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_NAME="$(basename "$0")"

echo "Running all build scripts..."

# Find all .sh files in the current directory, excluding this script
for script in "$SCRIPT_DIR"/*.sh; do
    script_basename="$(basename "$script")"

    # Skip this script itself
    if [ "$script_basename" = "$SCRIPT_NAME" ]; then
        continue
    fi

    echo "Running $script_basename..."
    if [ -x "$script" ]; then
        "$script"
    else
        sh "$script"
    fi
    echo "✓ $script_basename completed"
done

echo "All build scripts completed successfully!"
