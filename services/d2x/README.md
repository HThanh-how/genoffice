# GenOffice DOC conversion service

The service uses LibreOffice Writer to convert one legacy `.doc` at a time to a
temporary `.docx`. It does not persist uploaded documents. The public interface
is intentionally bound to `127.0.0.1:8765`; publish it only through a tunnel or
reverse proxy that has an abuse policy. The endpoint is
`POST /v1/convert/docx` with `Content-Type: application/msword` and a raw `.doc`
request body. `GET /health` returns `ok` when the converter binary exists.

Install `libreoffice-writer`, copy `server.py` to `/opt/genoffice-d2x/`, copy
`genoffice-d2x.service` to `/etc/systemd/system/`, then run
`systemctl daemon-reload && systemctl enable --now genoffice-d2x`.

Each node has a 30-per-IP and 120-total one-hour limit, a 20 MiB input limit,
one active conversion, a 45-second timeout, and a 50 MiB output limit. These local
limits supplement Cloudflare WAF; they do not prove that the request came from
an unmodified GenOffice installation. The tunnel connector must stop serving
traffic if `/health` fails. A public deployment must keep the conversion
process isolated from unrelated services.

`genoffice-d2x-tunnel.service` reads the private tunnel credentials from
`/etc/genoffice-d2x/credentials.json`. Keep that file outside Git and mode
`0600`. The health timer stops the local tunnel replica when the converter is
unavailable; Cloudflare can then use another replica. Cloudflare replicas do
not perform origin health checks or guarantee traffic balancing.

There is no document database to back up. Back up the versioned gateway source,
systemd unit, Cloudflare tunnel routing configuration and restoration notes.
Never back up temporary upload directories or tunnel credentials in Git.
