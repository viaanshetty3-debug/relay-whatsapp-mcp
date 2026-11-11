#!/bin/sh
cd "$(dirname "$0")" || exit 1
/usr/bin/python3 scripts/transfer-termux-session.py
relay_status=$?
printf '\nPress Return to close this window.'
read -r relay_unused
exit "$relay_status"
