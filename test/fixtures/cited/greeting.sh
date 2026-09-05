#!/bin/sh
# greeting.sh: a frozen source the fixture corpus and the docs cite.
# Do not edit: test/fixtures/pages and docs/src/content/docs pin these
# lines by hash, and CI asserts the outcomes.
set -e
NAME="${1:-world}"
if [ -z "$NAME" ]; then
  echo "usage: greeting.sh [name]" >&2
  exit 2
fi
echo "hello, $NAME"
exit 0
