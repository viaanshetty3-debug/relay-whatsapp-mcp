#!/bin/sh
cd "$(dirname "$0")" || exit 1
/usr/bin/python3 -B scripts/restart-relay.py
relay_result=$?
printf '\nPress Return to close this window.\n'
read -r relay_return
exit "$relay_result"
