#!/usr/bin/env bash
# Generate realistic-looking seed media for emulator demos/screenshots:
#   tmp/seed/       40 camera-roll JPEGs (plasma textures, IMG_YYYYMMDD_HHMMSS
#                   names, mtimes spread across recent weeks)
#   tmp/docs-seed/  a handful of txt/md/csv/pdf documents
#
# Push with:
#   adb push tmp/seed/. /sdcard/DCIM/Camera/
#   adb push tmp/docs-seed/. /sdcard/Documents/
#   adb shell content call --method scan_volume --uri content://media --arg external_primary
#
# Requires the nix devShell (magick) + fontconfig (fc-list) for the PDF text.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p tmp
cd tmp
rm -rf seed docs-seed
mkdir -p seed docs-seed

# 40 camera-roll photos spread across 2026-07-05 .. 2026-07-26
seeds=(11 23 42 57 68 71 83 99 104 118 127 139 145 152 168 174 187 190 203 219
       224 238 241 256 263 277 289 292 305 318 321 337 349 356 362 378 384 391 405 417)
for i in "${!seeds[@]}"; do
  s=${seeds[$i]}
  day=$(( 5 + i * 21 / 39 ))                      # spread over jul 5..26
  hh=$(( 8 + (s % 12) )); mm=$(( s % 60 )); ss=$(( (s * 7) % 60 ))
  name=$(printf 'IMG_202607%02d_%02d%02d%02d.jpg' "$day" "$hh" "$mm" "$ss")
  case $(( s % 3 )) in
    0) gen="plasma:fractal" ;;
    1) gen="plasma:tomato-navy" ;;
    2) gen="plasma:gold-teal" ;;
  esac
  magick -size 1600x1200 -seed "$s" "$gen" -blur 0x$(( s % 4 )) \
    -attenuate 0.3 +noise Gaussian -quality 90 "seed/$name"
  touch -d "2026-07-${day} ${hh}:${mm}:${ss}" "seed/$name"
done

# Documents
cat > docs-seed/grocery-list.txt <<'EOF'
- oat milk
- coffee beans (dark roast)
- rye bread
- eggs
- tomatoes
EOF
cat > docs-seed/meeting-notes-2026-07-14.md <<'EOF'
# Sync-up 2026-07-14
- budget approved for Q3
- NAS upgrade: order 2x 8TB drives
- backups: move phone backups off Google
EOF
cat > docs-seed/router-config-backup.txt <<'EOF'
# backup of openwrt /etc/config/network (redacted)
config interface 'lan'
        option proto 'static'
        option ipaddr '192.168.1.1'
EOF
seq 1 200 | awk '{printf "2026-%02d-%02d,%0.2f\n",($1%12)+1,($1%28)+1,$1*3.7}' > docs-seed/expenses-2026.csv

# The nix-shell ImageMagick has no default font — resolve one via fontconfig.
FONT=$(fc-list | grep -i 'DejaVuSans.ttf' | head -1 | cut -d: -f1)
if [ -z "$FONT" ]; then
  FONT=$(fc-list | grep -iE 'liberationsans-regular|NotoSans-Regular' | head -1 | cut -d: -f1)
fi
[ -n "$FONT" ] || { echo "no usable font found via fc-list" >&2; exit 1; }
for f in warranty-fridge receipt-bike-service insurance-policy; do
  magick -size 1240x1754 xc:white -font "$FONT" -fill '#222222' -pointsize 42 \
    -annotate +80+120 "$f (scanned)" -pointsize 24 \
    -annotate +80+200 "Scanned document, page 1 of 1" \
    "docs-seed/${f}.pdf"
done
touch -d "2026-07-10 09:15:00" docs-seed/grocery-list.txt
touch -d "2026-07-14 16:40:00" docs-seed/meeting-notes-2026-07-14.md
touch -d "2026-07-08 11:05:00" docs-seed/router-config-backup.txt
touch -d "2026-07-20 19:22:00" docs-seed/expenses-2026.csv
touch -d "2026-07-06 10:00:00" docs-seed/warranty-fridge.pdf
touch -d "2026-07-12 13:30:00" docs-seed/receipt-bike-service.pdf
touch -d "2026-07-18 15:45:00" docs-seed/insurance-policy.pdf

echo "photos: $(ls seed | wc -l), docs: $(ls docs-seed | wc -l)"
du -sh seed docs-seed
