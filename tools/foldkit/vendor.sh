#!/bin/sh
set -eu

root=$(git rev-parse --show-toplevel)
target="$root/repos/foldkit"
version=$(node -p "require('$root/apps/console/node_modules/foldkit/package.json').version")

if [ -f "$target/.version" ] && [ "$(cat "$target/.version")" = "$version" ]; then
  echo "repos/foldkit is already at foldkit@$version"
  exit 0
fi

rm -rf "$target"
git -c advice.detachedHead=false clone --quiet --depth 1 --filter=blob:none --branch "foldkit@$version" \
  https://github.com/foldkit/foldkit.git "$target"
rm -rf "$target/.git"
echo "$version" > "$target/.version"
echo "repos/foldkit is at foldkit@$version"
