#!/usr/bin/env bash
# ponytail: regenerate ~/.cursor/commands/*.md pointers after antigravity skill install
set -euo pipefail

SKILLS_DIR="${SKILLS_DIR:-$HOME/.cursor/skills}"
CMDS_DIR="${CMDS_DIR:-$HOME/.cursor/commands}"

mkdir -p "$CMDS_DIR"
count=0

for dir in "$SKILLS_DIR"/*/; do
  name=$(basename "$dir")
  [[ "$name" == "docs" ]] && continue
  skill="$dir/SKILL.md"
  [[ -f "$skill" ]] || continue

  title=$(grep -m1 '^# ' "$skill" 2>/dev/null | sed 's/^# //')
  [[ -n "$title" ]] || title="$name"

  cat > "$CMDS_DIR/$name.md" <<EOF
# $title

Load and follow the Antigravity skill at \`~/.cursor/skills/$name/SKILL.md\`.

1. Read that file completely before acting.
2. Apply its workflow to the user's request below.
EOF
  count=$((count + 1))
done

echo "Synced $count slash commands to $CMDS_DIR"
