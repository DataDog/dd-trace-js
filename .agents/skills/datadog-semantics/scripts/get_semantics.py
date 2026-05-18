#!/usr/bin/env python3
"""Query APM semantic conventions by category.

Usage:
    python get_semantics.py                    # List all categories
    python get_semantics.py database           # Get all tags for database category
    python get_semantics.py database required  # Get only required tags
    python get_semantics.py messaging recommended  # Get recommended tags
    python get_semantics.py --all              # Dump all categories and tags
"""

import json
import sys

try:
    from apm_semantic_conventions import (
        get_tags_for_category,
        list_categories,
    )

    HAS_PACKAGE = True
except ImportError:
    HAS_PACKAGE = False


def print_categories():
    """List all available semantic categories."""
    categories = list_categories()
    print("Available categories:")
    for cat in sorted(categories):
        print(f"  - {cat}")


def print_tags_for_category(category: str, level: str | None = None):
    """Print tags for a category, optionally filtered by requirement level."""
    try:
        tags = get_tags_for_category(category)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    levels = ["required", "recommended", "conditionally_required", "opt_in"]

    if level:
        levels = [level]

    for lvl in levels:
        attrs = tags.get(lvl, [])
        if not attrs:
            continue

        print(f"\n## {lvl.upper()} ({len(attrs)} tags)")
        print("-" * 40)

        for attr in attrs:
            print(f"\n{attr.key}")
            print(f"  Type: {attr.value_type}")
            if attr.description:
                # Truncate long descriptions
                desc = (
                    attr.description[:100] + "..."
                    if len(attr.description) > 100
                    else attr.description
                )
                print(f"  Description: {desc}")
            if attr.examples:
                examples = attr.examples[:3]  # Show max 3 examples
                print(f"  Examples: {examples}")


def print_all_categories():
    """Dump all categories and their tags as JSON."""
    result = {}
    for category in list_categories():
        try:
            tags = get_tags_for_category(category)
            result[category] = {
                level: [
                    {
                        "key": attr.key,
                        "type": attr.value_type,
                        "description": attr.description,
                        "examples": attr.examples,
                    }
                    for attr in attrs
                ]
                for level, attrs in tags.items()
                if attrs
            }
        except Exception:
            continue

    print(json.dumps(result, indent=2))


def main():
    if not HAS_PACKAGE:
        print("Error: apm-semantic-conventions package not installed", file=sys.stderr)
        print("Install with: pip install apm-semantic-conventions", file=sys.stderr)
        sys.exit(1)

    args = sys.argv[1:]

    if not args:
        print_categories()
        return

    if args[0] == "--all":
        print_all_categories()
        return

    if args[0] == "--help" or args[0] == "-h":
        print(__doc__)
        return

    category = args[0]
    level = args[1] if len(args) > 1 else None

    if level and level not in ["required", "recommended", "conditionally_required", "opt_in"]:
        print(f"Error: Invalid level '{level}'", file=sys.stderr)
        print(
            "Valid levels: required, recommended, conditionally_required, opt_in", file=sys.stderr
        )
        sys.exit(1)

    print(f"Semantic conventions for: {category}")
    print("=" * 40)
    print_tags_for_category(category, level)


if __name__ == "__main__":
    main()
