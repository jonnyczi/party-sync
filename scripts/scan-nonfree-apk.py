#!/usr/bin/env python3
"""Fail if an APK contains known non-free Google libraries (Firebase / GMS).

This is the regression guard for the de-Googling done in modules/copyparty-notify:
F-Droid rejects any app that links proprietary Google libs, so CI scans the
built release APK's dex for their class prefixes and exits non-zero on a hit.

Usage: scan-nonfree-apk.py path/to/app-release.apk
"""
import re
import sys
import zipfile

# Class-name prefixes (as stored in dex) of libraries F-Droid disallows.
BANNED = re.compile(rb"com/google/(firebase|android/gms)/")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: scan-nonfree-apk.py <apk>", file=sys.stderr)
        return 2
    apk = sys.argv[1]

    hits: set[str] = set()
    with zipfile.ZipFile(apk) as z:
        dex = [n for n in z.namelist() if n.endswith(".dex")]
        if not dex:
            print(f"error: no .dex entries in {apk}", file=sys.stderr)
            return 2
        for name in dex:
            data = z.read(name)
            for m in BANNED.finditer(data):
                hits.add(m.group(0).decode())

    if hits:
        print(f"FAIL: non-free class prefixes found in {apk}:")
        for h in sorted(hits):
            print(f"  - {h}")
        print("F-Droid would reject this build. Check for a dependency that "
              "pulls in Firebase/GMS (e.g. a reintroduced expo-notifications).")
        return 1

    print(f"OK: {apk} contains no Firebase/GMS classes ({len(dex)} dex scanned).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
