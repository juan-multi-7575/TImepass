#!/usr/bin/env bash
# Install the timepass-gemini skill into the harness skill root.
#
# The canonical source is this directory, inside the timepass repo. It is copied
# rather than symlinked because the skill root holds only real directories, and
# a symlink would make it ambiguous which copy an agent actually read.
#
# Re-run after editing SKILL.md or anything in references/.

set -euo pipefail

SKILL_NAME="timepass-gemini"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_ROOT="${AGENTS_SKILLS_ROOT:-$HOME/.agents/skills}"
DEST_DIR="$DEST_ROOT/$SKILL_NAME"

if [ ! -f "$SRC_DIR/SKILL.md" ]; then
  echo "error: $SRC_DIR/SKILL.md is missing; run this from the skill directory" >&2
  exit 1
fi

mkdir -p "$DEST_ROOT"
rm -rf "$DEST_DIR"
cp -R "$SRC_DIR" "$DEST_DIR"
rm -f "$DEST_DIR/install.sh" "$DEST_DIR/skill.test.js"

echo "Installed $SKILL_NAME -> $DEST_DIR"
echo "The skill appears in a new session's skill catalog; the current session"
echo "keeps the catalog it started with."
