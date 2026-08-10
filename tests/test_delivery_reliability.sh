#!/bin/bash
# Durable delivery unit/fault tests plus reliability/load harness tests.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"
bun test agent/delivery tests/reliability
