---
description: Ship a release — bump version, build signed+notarized, publish to GitHub
argument-hint: [patch|minor|major|x.y.z]
---

Ship a new release of Agent Canvas. The argument says how to bump the version:
`patch` / `minor` / `major`, or an explicit version like `0.4.0`. No argument
defaults to `patch`.

Argument: $ARGUMENTS

Follow these steps in order. Each step gates the next — stop and report if one
fails; never publish a build that failed a check.

## 1. Preflight

- Working tree must be clean (`git status`). If there are uncommitted changes,
  stop and ask whether to commit them first — never ship with a dirty tree.
- Must be on `main` and in sync with `origin/main` (push if only ahead; stop if
  behind).

## 2. Bump the version

- Read the current version from `package.json`. Compute the new one from the
  argument (strip any `-dev` suffix before bumping — e.g. `0.3.0-dev` +
  `patch` → `0.3.0`; if a `-dev` suffix was present, stripping it IS the patch
  bump).
- Released versions are plain `x.y.z` — never ship a prerelease suffix, the
  updater treats it as a prerelease.
- Edit `package.json`, then commit and push:
  `git commit -am "Release v<version>" && git push`

## 3. Build signed + notarized

Run (background it — notarization waits on Apple, typically 1–5 min):

```sh
CODESIGN_IDENTITY="Developer ID Application: Rakan ALYahya (HS29478CLK)" \
NOTARY_PROFILE=canvas-notary Packaging/package.sh
```

## 4. Verify before publishing

All three must pass:

```sh
spctl -a -vv "dist/mac-arm64/Agent Canvas.app"        # → accepted, Notarized Developer ID
xcrun stapler validate "dist/mac-arm64/Agent Canvas.app"
plutil -extract CFBundleShortVersionString raw "dist/mac-arm64/Agent Canvas.app/Contents/Info.plist"  # → matches the new version
```

## 5. Publish

```sh
Packaging/release.sh
```

## 6. Report

- Give the release URL and the dmg download link.
- Check `gh repo view reekko1/agent-canvas --json visibility` — if the repo is
  still PRIVATE, remind that installed copies can't see updates and shared dmg
  links won't work until it's public.
- Set the local version to the next dev version (`<next-patch>-dev`, e.g.
  shipped `0.3.0` → `0.3.1-dev`), commit as `Back to dev: v<next-patch>-dev`,
  and push — so dev builds are never confused with the released version.
