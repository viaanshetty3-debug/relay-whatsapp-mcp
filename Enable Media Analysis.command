#!/bin/sh
cd "$(dirname "$0")" || exit 1
/usr/bin/python3 -B scripts/setup-media-analysis.py
relay_result=$?
printf '\nPress Return to close this window.\n'
read -r relay_return
exit "$relay_result"
