// Preloaded (node --import) into the bridge and agent started by relay-service.mjs.
// If the runner disappears — even if it is killed outright — the IPC channel
// closes and this process exits, so no orphan keeps the port or polls the relay.
// (launchd and systemd also clean up; Windows Task Scheduler does not.)
if (process.send && process.connected) {
  process.on('disconnect', () => process.exit(0));
  process.channel?.unref?.();
}
