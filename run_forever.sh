#!/usr/bin/env bash
cd /home/DenisErmakov/apps/onboarding_cross_node || exit 1

while true; do
  echo "=== START $(date) ==="
  node server.js
  code=$?
  echo "=== EXIT $(date) code=$code ==="
  sleep 5
done
