#!/usr/bin/env bash
#
# Generate categorized release notes from git log and PR labels.
#
# Usage:
#   ./scripts/release-notes.sh                # first release
#   ./scripts/release-notes.sh @tsfga/core@0.1.0  # since tag
#
# Requires: gh CLI authenticated with repo access.

set -euo pipefail

PREV_TAG="${1:-}"
REPO="${GITHUB_REPOSITORY:-emfga/tsfga}"

if [ -n "$PREV_TAG" ]; then
  range="${PREV_TAG}..HEAD"
else
  range=""
fi

# Collect commits (hash + subject), skip merges
if [ -n "$range" ]; then
  commits=$(git log --format="%H %s" "$range" --no-merges)
else
  commits=$(git log --format="%H %s" --no-merges)
fi

# Category arrays
breaking=""
features=""
bugs=""
docs=""
tooling=""
other=""

while IFS= read -r line; do
  [ -z "$line" ] && continue

  sha="${line%% *}"
  subject="${line#* }"
  short_sha="${sha:0:7}"

  # Skip release commits
  case "$subject" in
    Release*|"Version Packages"*) continue ;;
  esac

  # Look up associated PR via GitHub API
  pr_json=$(
    gh api "repos/${REPO}/commits/${sha}/pulls" \
      --jq '.[0] // empty' 2>/dev/null || true
  )

  if [ -n "$pr_json" ]; then
    pr_number=$(echo "$pr_json" | jq -r '.number')
    pr_author=$(echo "$pr_json" | jq -r '.user.login')
    labels=$(
      echo "$pr_json" \
        | jq -r '[.labels[].name] | join(",")'
    )
    entry="- ${subject} (@${pr_author} ${short_sha}"
    entry="${entry} in #${pr_number})"
  else
    entry="- ${subject} (${short_sha})"
    labels=""
  fi

  # Categorize by label (first match wins)
  case ",$labels," in
    *,breaking,*)
      breaking="${breaking}${entry}"$'\n' ;;
    *,feature,*)
      features="${features}${entry}"$'\n' ;;
    *,bug,*)
      bugs="${bugs}${entry}"$'\n' ;;
    *,documentation,*)
      docs="${docs}${entry}"$'\n' ;;
    *,tooling,*)
      tooling="${tooling}${entry}"$'\n' ;;
    *)
      other="${other}${entry}"$'\n' ;;
  esac
done <<< "$commits"

# Output markdown sections (only non-empty categories)
output=""

if [ -n "$breaking" ]; then
  output="${output}## Breaking Changes"$'\n\n'"${breaking}"$'\n'
fi
if [ -n "$features" ]; then
  output="${output}## Features"$'\n\n'"${features}"$'\n'
fi
if [ -n "$bugs" ]; then
  output="${output}## Bug Fixes"$'\n\n'"${bugs}"$'\n'
fi
if [ -n "$docs" ]; then
  output="${output}## Documentation"$'\n\n'"${docs}"$'\n'
fi
if [ -n "$tooling" ]; then
  output="${output}## Tooling"$'\n\n'"${tooling}"$'\n'
fi
if [ -n "$other" ]; then
  output="${output}## Other"$'\n\n'"${other}"$'\n'
fi

if [ -z "$output" ]; then
  echo "No changes found."
else
  echo "$output"
fi
