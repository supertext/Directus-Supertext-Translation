#!/usr/bin/env bash
# Copies Supertext Plugin Health (TypeScript, built JavaScript) into vendor/supertext-plugin-health.
# Source: https://github.com/Supertext/Commando-Center-Supertext-Translation (plugin-health/typescript).
#
#   scripts/vendor-plugin-health.sh                  # latest main
#   scripts/vendor-plugin-health.sh <commit|branch>  # a tag (plugin-health-vX.Y.Z), branch or commit
#   PLUGIN_HEALTH_DIR=/path/to/clone scripts/vendor-plugin-health.sh   # a local clone, as it is
#
# It is a devDependency ("supertext-plugin-health": "file:vendor/supertext-plugin-health"), next
# to the Supertext SDK's, that the extension build bundles into dist/, so sites install nothing
# besides the extension. The copy's package.json makes it an installable package
# (node_modules/supertext-plugin-health is a link to it).
set -euo pipefail
cd "$(dirname "$0")/.."
ref="${1:-main}"
dest=vendor/supertext-plugin-health
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [ -n "${PLUGIN_HEALTH_DIR:-}" ]; then
  src="$(cd "$PLUGIN_HEALTH_DIR" && pwd)"
else
  git clone -q https://github.com/Supertext/Commando-Center-Supertext-Translation "$work/center"
  git -C "$work/center" checkout -q "$ref"
  src="$work/center"
fi
commit="$(git -C "$src" rev-parse HEAD)"
version="$(node -p "require('$src/plugin-health/typescript/package.json').version")"
cp -R "$src/plugin-health/typescript" "$work/ts"
rm -rf "$work/ts/node_modules" "$work/ts/dist"
(cd "$work/ts" && npm ci --no-audit --no-fund --silent && npm run --silent build)
rm -rf "$dest"
mkdir -p "$dest"
(cd "$work/ts/dist" && find . -name '*.js' -o -name '*.d.ts' | while read -r f; do mkdir -p "$OLDPWD/$dest/$(dirname "$f")"; cp "$f" "$OLDPWD/$dest/$f"; done)
# Plugin Health 0.4+ reads the dashboard address from config.json with an import attribute
# (`import config from './config.json' with { type: 'json' }`), which not every bundler accepts:
# the copy gets the same values as a constant instead.
if [ -f "$src/plugin-health/typescript/src/config.json" ]; then
  node -e '
    const fs = require("fs");
    const [index, json] = process.argv.slice(1);
    const config = JSON.parse(fs.readFileSync(json, "utf8"));
    const source = fs.readFileSync(index, "utf8");
    const line = /^import config from \x27\.\/config\.json\x27 with \{ type: \x27json\x27 \};?$/m;
    if (!line.test(source)) { console.error("config.json import not found in " + index); process.exit(1); }
    fs.writeFileSync(index, source.replace(line, "// Inlined from config.json by scripts/vendor-plugin-health.sh.\nconst config = " + JSON.stringify(config) + ";"));
  ' "$dest/index.js" "$src/plugin-health/typescript/src/config.json"
fi
cp "$src/plugin-health/typescript/LICENSE" "$dest/LICENSE"
printf '{\n  "name": "supertext-plugin-health",\n  "version": "%s",\n  "private": true,\n  "type": "module",\n  "main": "./index.js",\n  "types": "./index.d.ts",\n  "exports": {\n    ".": { "types": "./index.d.ts", "import": "./index.js" }\n  },\n  "license": "MIT"\n}\n' "$version" > "$dest/package.json"
printf '%s\n' "$commit" > "$dest/COMMIT"
printf '%s\n' "$version" > "$dest/VERSION"
cat > "$dest/README.md" <<README
# Supertext Plugin Health (bundled copy)

Built JavaScript of the TypeScript part of [Supertext Plugin Health](https://github.com/Supertext/Commando-Center-Supertext-Translation/tree/main/plugin-health) (\`plugin-health/typescript\`), version $version, commit \`$commit\`. \`package.json\` makes it the \`supertext-plugin-health\` devDependency that the extension build bundles into \`dist/\`.

Don't edit these files: fix it in Commando-Center-Supertext-Translation/plugin-health, then run \`scripts/vendor-plugin-health.sh\`.
README
# package-lock.json records the linked package's version: update it when that changed.
if [ "$(node -p "(require('./package-lock.json').packages['$dest'] || {}).version")" != "$version" ]; then
  npm install --package-lock-only --no-audit --no-fund --silent
fi
echo "$dest: Supertext Plugin Health (TypeScript) $version from commit $commit"
