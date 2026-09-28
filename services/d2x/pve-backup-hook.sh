#!/bin/sh
set -eu

# Proxmox passes TARGET only during backup-end. The remote copy survives loss
# of the PVE host; it includes the tunnel credential, so keep it root-only.
[ "${1:-}" = 'backup-end' ] || exit 0
[ "${3:-}" = '195' ] || exit 0

target=${TARGET:-}
case "$target" in
  /var/lib/vz/dump/vzdump-lxc-195-*.tar.zst) ;;
  *) echo 'Unexpected GenOffice backup target' >&2; exit 1 ;;
esac
[ -f "$target" ] || exit 1

name=$(basename "$target")
remote=root@100.95.149.49
directory=/var/backups/genoffice-d2x
ssh -o BatchMode=yes "$remote" "install -d -m 0700 '$directory'"
scp -q "$target" "$remote:$directory/$name"
local_hash=$(sha256sum "$target" | cut -d ' ' -f 1)
remote_hash=$(ssh -o BatchMode=yes "$remote" "chmod 600 '$directory/$name'; sha256sum '$directory/$name'" | cut -d ' ' -f 1)
[ "$local_hash" = "$remote_hash" ] || { echo 'Off-host backup checksum mismatch' >&2; exit 1; }
ssh -o BatchMode=yes "$remote" "find '$directory' -maxdepth 1 -type f -name 'vzdump-lxc-195-*.tar.zst' -mtime +35 -delete"
echo "Copied and verified $name on huy"
