# NEAL Matrix discovery

This static project delegates the permanent Matrix identity
`matrix.nealtheseal.org` to NEAL's initial Tailscale Funnel endpoint.

- Federation: `matrix-home.tailadbebb.ts.net:10000`
- Client base URL: `https://matrix-home.tailadbebb.ts.net:10000/`

The custom domain is `matrix.nealtheseal.org`; it is attached and live. The
Funnel route terminates at the filtered gateway on `127.0.0.1:8011`, not raw
Synapse, and the public `/_synapse/admin/*` path must continue to return `404`.
