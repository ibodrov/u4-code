#!/bin/sh
# Find official T3 Code identity values that are new since the recorded baseline.
# Upstream adds new state paths, sockets, labels and env names often. After a rebase,
# run this check. Fix each new match, or accept it with --update when it is deliberate.
#   packaging/u4/check-identity.sh            compare with the baseline (exit 1 on new matches)
#   packaging/u4/check-identity.sh --update   record the current state as the baseline
set -eu

repo="$(cd "$(dirname "$0")/../.." && pwd)"
baseline="$repo/packaging/u4/identity-baseline.tsv"

# name<TAB>extended regex. Keep the names stable: they are baseline keys.
patterns='t3-home	(homedir\(\)|~|\$HOME|HOME)[^A-Za-z0-9]{0,6}\.t3([/"'"'"'` ]|$)
t3-env	T3CODE_HOME
t3-app-id	com\.t3tools
t3-slug	t3code
t3-name	T3 Code'

scan() {
  printf '%s\n' "$patterns" | while IFS="$(printf '\t')" read -r name regex; do
    git -C "$repo" grep -c -I -E "$regex" -- . \
      ':!.repos' ':!docs' ':!*.md' ':!*.test.*' ':!**/fixtures/**' ':!**/__snapshots__/**' \
      ':!packaging/u4' ':!evals' ':!patches' ':!apps/mobile' ':!apps/marketing' \
      ':!pnpm-lock.yaml' 2>/dev/null |
      awk -F: -v n="$name" '{ c = $NF; sub(/:[0-9]+$/, ""); printf "%s\t%s\t%s\n", n, $0, c }'
  done | LC_ALL=C sort
}

if [ "${1:-}" = "--update" ]; then
  scan >"$baseline"
  echo "check-identity: baseline updated ($(wc -l <"$baseline") entries)"
  exit 0
fi

[ -f "$baseline" ] || { echo "check-identity: no baseline; run with --update first" >&2; exit 2; }

current="$(mktemp)"
trap 'rm -f "$current"' EXIT
scan >"$current"

# Report entries whose count grew or that are new; ignore entries that shrank or disappeared.
new="$(awk -F'\t' 'NR == FNR { base[$1 FS $2] = $3; next }
  { k = $1 FS $2; b = (k in base) ? base[k] : 0; if ($3 > b) printf "  %-10s %s (+%d)\n", $1, $2, $3 - b }' \
  "$baseline" "$current")"

if [ -n "$new" ]; then
  echo "check-identity: new T3 identity matches since the baseline:"
  printf '%s\n' "$new"
  echo "Fix them to use packages/shared/src/productIdentity.ts or U4 text."
  echo "If a match is deliberate, run: packaging/u4/check-identity.sh --update"
  exit 1
fi
echo "check-identity: no new T3 identity matches"
