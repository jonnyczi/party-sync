#!/usr/bin/env bash
# Capture a light+dark screenshot pair of the current emulator screen into
# tmp/shots/<slug>-{light,dark}.png (1080x2424 raw PNGs).
#
# Works because the app manifest has uiMode in configChanges: `cmd uimode night`
# flips the theme in place — no activity recreate, no re-navigation needed.
# Requires: a booted device on adb. Run from anywhere in the repo.
set -euo pipefail
cd "$(dirname "$0")/../.."
slug=$1
mkdir -p tmp/shots
adb shell input keyevent 111 || true   # dismiss keyboard if open
sleep 0.5
adb exec-out screencap -p > "tmp/shots/${slug}-light.png"
adb shell cmd uimode night yes
sleep 2
adb exec-out screencap -p > "tmp/shots/${slug}-dark.png"
adb shell cmd uimode night no
sleep 2
echo "captured ${slug} (light+dark)"
