#!/bin/sh
# Rebase the U4 patch stack onto a newer upstream T3 Code revision, on a new branch.
# u4/main is not changed. Review the result, then fast-forward u4/main to it.
#   packaging/u4/sync-upstream.sh <upstream-tag-or-commit> [branch]
# Example: packaging/u4/sync-upstream.sh v0.1.11
set -eu

repo="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo"

target="${1:?usage: sync-upstream.sh <upstream-tag-or-commit> [branch]}"
source_branch="u4/main"
branch="${2:-u4/sync-$(printf '%s' "$target" | tr '/' '-')}"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "sync-upstream: the working tree has changes; commit or stash them first" >&2
  exit 1
fi

git fetch --quiet upstream --tags
new_base="$(git rev-parse --verify "$target^{commit}")"
old_base="$(git merge-base "$source_branch" "$new_base")"
if [ "$old_base" = "$new_base" ]; then
  echo "sync-upstream: $source_branch already contains $target"
  exit 0
fi
if ! git merge-base --is-ancestor "$old_base" "$new_base"; then
  echo "sync-upstream: $target is not a descendant of the current base $old_base" >&2
  exit 1
fi

echo "sync-upstream: $source_branch is based on $(git describe --tags --always "$old_base")"
echo "sync-upstream: upstream moved $(git rev-list --count "$old_base..$new_base") commits to $target"
echo "sync-upstream: U4 patches: $(git rev-list --count "$old_base..$source_branch")"

git branch --force "$branch" "$source_branch"
git switch --quiet "$branch"
# rerere replays conflict resolutions that were recorded in earlier syncs.
if ! git -c rerere.enabled=true -c rerere.autoUpdate=true rebase --onto "$new_base" "$old_base" "$branch"; then
  cat >&2 <<EOF

sync-upstream: the rebase stopped on a conflict. Resolve it, then run:
  git rebase --continue
When the rebase finishes, check the result:
  git range-diff $old_base..$source_branch $new_base..$branch
  packaging/u4/check-identity.sh
  vp i && vp run check:changed $new_base
EOF
  exit 1
fi

echo
echo "== Patch changes (range-diff) =="
git range-diff --no-color "$old_base..$source_branch" "$new_base..$branch" | sed -n '1,80p'
echo
packaging/u4/check-identity.sh || identity_failed=1
cat <<EOF

sync-upstream: $branch is $source_branch rebased onto $target.
Next steps:
  vp i && vp run check:changed $new_base
  node scripts/build-desktop-artifact.ts --platform linux --target AppImage --arch x64 \\
    --build-version <version>-u4.<n> --output-dir release
  When it is good: git switch $source_branch && git merge --ff-only $branch
EOF
[ -z "${identity_failed:-}" ]
