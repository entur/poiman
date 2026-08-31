#!/bin/sh
# Run from the preinstall hook. poiman relies on Bun-specific features (the
# `alias` map in package.json, bun:test, Bun.sql), and CI and the Dockerfile
# install from bun.lock, so a lockfile written by npm/yarn/pnpm would be
# ignored while silently diverging. Refuse the install instead.
#
# npm, yarn, pnpm and bun all set npm_config_user_agent to "<tool>/<version>
# ...", so the part before the first slash names the installer.
[ "${npm_config_user_agent%%/*}" = bun ] && exit 0

echo 'poiman uses Bun-specific features (alias map, bun:test). Run `bun install`.' >&2
exit 1
