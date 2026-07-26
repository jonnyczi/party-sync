#!/usr/bin/env bash
# Dump the booted emulator's current UI hierarchy and print every labeled node
# as "(x,y)  ClassName  'label'  clickable=…" — tap-target discovery for
# driving the app with `adb shell input tap X Y`.
#
# Requires: a booted device on adb, python3 on the host.
# Gotchas: re-run after EVERY navigation (coords go stale — lists reorder);
# uiautomator occasionally errors with "could not get idle state" — retry once.
set -euo pipefail
dump="${TMPDIR:-/tmp}/ui-dump.xml"
adb shell uiautomator dump /sdcard/ui.xml >/dev/null
adb exec-out cat /sdcard/ui.xml > "$dump"
python3 - "$dump" <<'EOF'
import re, sys, xml.etree.ElementTree as ET
tree = ET.parse(sys.argv[1])
for node in tree.iter('node'):
    text = node.get('text') or ''
    desc = node.get('content-desc') or ''
    cls = node.get('class') or ''
    if not text and not desc and 'EditText' not in cls:
        continue
    m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds'))
    x = (int(m.group(1)) + int(m.group(3))) // 2
    y = (int(m.group(2)) + int(m.group(4))) // 2
    label = text or desc
    print(f"({x},{y})  {cls.split('.')[-1]:<12} {label[:60]!r}  clickable={node.get('clickable')}")
EOF
