#!/bin/bash
# Rebuild the timescaledb extension from scratch and run its tests.
set -euo pipefail

# clean timescaledb build artifacts (the rest of the postgres build is reused).
# They are created by the docker build as root, so remove them from inside the builder image.
docker run --rm -v "$(pwd)/postgres-pglite:/work" --workdir=/work electricsql/pglite-builder:6.0.5-1 \
  rm -rf pglite/other_extensions/timescaledb/.build dist/extensions/other/timescaledb.tar.gz
rm -rf packages/pglite-extensions/pglite-timescaledb/release \
  packages/pglite-extensions/pglite-timescaledb/dist

pnpm build:all && cd packages/pglite-extensions/pglite-timescaledb && pnpm test
