#!/usr/bin/python3
"""User-run Mac launcher: reload the bridge without replacing its saved session."""
import importlib.util
from pathlib import Path

def main():
    script = Path(__file__).with_name('transfer-termux-session.py')
    spec = importlib.util.spec_from_file_location('relay_session_helpers', script)
    helpers = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helpers)
    helpers.validate_configuration()
    token = (helpers.ROOT/'data'/'owner-token').read_text().strip()
    if len(token) < 32:
        raise RuntimeError('No valid saved owner token was found. Start Relay normally first.')
    # Verify the listening process belongs to this project before stopping it.
    pids = helpers.local_listeners()
    print('Restarting your Mac bridge with the saved WhatsApp session.')
    helpers.stop_local(pids)
    connected = helpers.start_local(token)
    if connected:
        print('Verified: WhatsApp is connected. The updated media tools are ready.')
    else:
        print('The bridge is running. Check the dashboard while WhatsApp reconnects.')
    print('Dashboard: http://127.0.0.1:8787')
    print('Refresh the dashboard and reconnect your AI client to load the updated tools.')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Restart could not finish: '+str(error))
        raise SystemExit(1)
