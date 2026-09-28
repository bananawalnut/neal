# NEAL Hermes health event

The read-only administrator portal monitors the local `neal` Hermes gateway
through a small Matrix room state event. The event contains only operational
status, a timestamp, the fixed profile/user/room binding, the Hermes version,
and whether the gateway is service-managed. It contains no credential, host
path, process ID, model, prompt, message, or tool output.

Install the macOS launch agent from this checkout:

```bash
./infra/neal-comms/hermes-health/install_launch_agent.sh
```

The installed script reads the existing NEAL profile environment at runtime.
The access token never enters the launchd property list or repository. The
publisher refuses to run if the profile identity, home room, or room allowlist
does not match the canonical NEAL GC.

The event type is `org.neal.hermes.health`, with state key `primary`. The portal
considers an online heartbeat stale after 150 seconds. Removing or disabling
the launch agent does not affect the Hermes gateway itself.
