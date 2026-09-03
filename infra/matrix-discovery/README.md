# Zenith Matrix discovery

This isolated static deployment publishes Matrix delegation for the permanent
homeserver identity `matrix.zenith-research.ca`.

- Federation delegates to the public, federation-only Tailscale Funnel on port
  443.
- Matrix clients use the tailnet-only Tailscale Serve endpoint on port 8443.
- No client or administration API is exposed by the public federation ingress.

The custom domain for this project is `matrix.zenith-research.ca`.
