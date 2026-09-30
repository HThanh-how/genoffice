# d2x.clouds.io.vn

Deployed 2026-09-28. GenOffice sends legacy `.doc` or `.ppt` bytes to this
endpoint when online conversion is enabled or accepted. The service responds
with `.docx` or `.pptx` bytes and does not retain the document.

## Nodes

| Node         | Runtime                                 | Local service           | Tunnel replica                 |
| ------------ | --------------------------------------- | ----------------------- | ------------------------------ |
| `huy`        | Debian 12 VM, 4 cores / 8 GiB           | `genoffice-d2x.service` | `genoffice-d2x-tunnel.service` |
| `lxc-109`    | Ubuntu 22.04 LXC, 4 cores / 2 GiB       | same                    | same                           |
| `pve` CT 195 | Debian 12, 2 cores / 2 GiB, 12 GiB root | same                    | same                           |

Cloudflare Tunnel `genoffice-d2x` is `9b24459b-7227-476c-9c01-7c21a175e3ec`.
It routes `d2x.clouds.io.vn` to `http://127.0.0.1:8765` on each replica. The
private tunnel credential lives at `/etc/genoffice-d2x/credentials.json` on
each node, outside this repository. Keep it root-only. Never print it in logs.

Check `https://d2x.clouds.io.vn/health` and the `genoffice-d2x` and
`genoffice-d2x-tunnel` services on all three nodes. `genoffice-d2x-watch.timer`
checks the local origin every 15 seconds; a failed origin stops that node's
tunnel connector. Cloudflare Tunnel replicas provide basic failover, not
traffic steering or an end-to-end zero-error guarantee. One LibreOffice job per
node can run at once; extra simultaneous requests receive 503 and the client
can retry.

## Limits and privacy

The gateway accepts only raw OLE `.doc` or `.ppt` uploads up to 20 MiB, runs each
conversion for at most 45 seconds, and rejects output over 50 MiB. Each node
allows up to 30 requests per IP and 120 total per hour. These are local
in-memory limits and reset on service restart. All conversion files live in a
temporary directory and are deleted when the request ends. Logs include
request path/status and local peer address, never file contents or names. The endpoint
is public and anonymous; these limits reduce abuse but do not authenticate
GenOffice installations. For larger public use, put Cloudflare WAF rate limits
in front or move to user accounts and shared quotas.

## Backup and restore

PVE backup job `genoffice-d2x-195` snapshots CT 195 every Sunday at 03:30,
keeps four local backups, and runs
`/usr/local/sbin/genoffice-d2x-backup-hook.sh` to copy each archive to
`huy:/var/backups/genoffice-d2x/`, verify SHA-256, and expire off-host copies
older than 35 days. A backup was taken and verified on both hosts on
2026-09-28. Initial configuration tarballs for `huy` and `lxc-109` live under
`/var/backups/genoffice-d2x/` on those hosts and were copied to PVE. The
service source and systemd units are versioned in this repository. Uploaded
documents have no backup because they are intentionally ephemeral.

To rebuild a converter node: install LibreOffice Writer and Impress, restore `server.py`
and the systemd units from this repository, restore the private tunnel
credential from another healthy node with mode `0600`, then enable the
converter and watch timer. For CT 195, restore a verified `vzdump-lxc-195`
archive with Proxmox's normal restore workflow on a spare CT ID first, test
the converter, then switch the node. Avoid restoring over a live CT without a
maintenance window.
