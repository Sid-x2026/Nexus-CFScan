#!/bin/sh
# Build nexus-cfscan-agent on Linux/macOS (no network needed, stdlib only).
set -e
cd "$(dirname "$0")"
go vet ./...
go build -o cfscan-agent .
echo "Built ./cfscan-agent — run it, then open the Nexus-CFScan page."
