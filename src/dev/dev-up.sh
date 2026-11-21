#!/usr/bin/env bash
# Brings up the durable local dev deployment from the sibling checkouts under PRAGMATIC_E2E_REPOS_DIR (default: the
# folder pragmatic-e2e sits in), each with `npm ci` done: pragmatic-platform-admin (the console) and
# pragmatic-tenant-admin (its tenant portal, built with `npm run build` in tenant-portal/); the dev images are baked from
# the checkouts of pragmatic-env-server, -ui-unpack, -hive-agent, -tenant-admin, -tenant-idp and -postgres there:
#   - the dev images the console runs in local mode (src/dev/dev-images.ts)
#   - the dev kind cluster `pragmatic-dev` (context kind-pragmatic-dev) the local hive runs on
#   - operator (platform admin) panel  : http://127.0.0.1:7000     (loopback)
#   - tenant admin panel               : https://<tenant>.lvh.me   (Caddy :443 -> tenant plane :7100)
#   - the console's own Postgres       : 127.0.0.1:55433           (container pragmatic-dev-postgres)
# Durable state: the Postgres volume pragmatic-dev-postgres-data and the data folder PRAGMATIC_DEV_DATA_ROOT (default
# ~/.pragmatic/dev-stack/data: keys, the database password and URL file, the JSON files of before the database), never
# a folder inside a repository. Re-run anytime; state persists.
# This script runs the console in the FOREGROUND (it is the long-lived process); the Caddy TLS proxy runs as a detached
# container started first. Ctrl-C stops the console; run dev-down.sh to also stop Caddy.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E="$(cd "$HERE/../.." && pwd)"
REPOS="${PRAGMATIC_E2E_REPOS_DIR:-$(cd "$E2E/.." && pwd)}"
ADMIN="$REPOS/pragmatic-platform-admin"
TENANT_ADMIN="$REPOS/pragmatic-tenant-admin"
for repo in "$ADMIN" "$TENANT_ADMIN"; do
	[ -d "$repo" ] || { echo "[dev-up] $repo is not checked out (set PRAGMATIC_E2E_REPOS_DIR to the folder of the sibling checkouts)" >&2; exit 1; }
done
DATA="${PRAGMATIC_DEV_DATA_ROOT:-$HOME/.pragmatic/dev-stack/data}"
mkdir -p "$DATA"
export PRAGMATIC_ADMIN_DATA_ROOT="$DATA"
CERTS="$HOME/.pragmatic/dev-stack/certs"
[ -d "$CERTS" ] || { echo "[dev-up] no Caddy TLS material in $CERTS (lvh.crt, lvh.key, dev-ca.crt; README.md)" >&2; exit 1; }
CERTS_WIN="$(cd "$CERTS" && pwd -W)"
CADDYFILE_WIN="$(cd "$HERE" && pwd -W)/Caddyfile"

# 0) The dev images, each baked from its container repository under $REPOS (src/dev/dev-images.ts; warm bakes take
#    seconds; PRAGMATIC_DEV_SKIP_IMAGE_BAKE=1 skips it), then the dev kind cluster `pragmatic-dev` the local hive runs on
#    (created when missing; the images re-loaded each run).
if [ "${PRAGMATIC_DEV_SKIP_IMAGE_BAKE:-}" != "1" ]; then
	(cd "$E2E" && npx tsx src/dev/dev-images.ts)
fi
(cd "$E2E" && npx tsx src/dev/dev-cluster.ts up)

# 1) Caddy TLS terminator on :443 -> tenant plane (host.docker.internal:7100).
docker rm -f pragmatic-dev-caddy >/dev/null 2>&1 || true
MSYS_NO_PATHCONV=1 docker run -d --name pragmatic-dev-caddy \
	-p 443:443 \
	-v "${CERTS_WIN}:/certs:ro" \
	-v "${CADDYFILE_WIN}:/etc/caddy/Caddyfile:ro" \
	caddy:2 >/dev/null
echo "[dev-up] caddy TLS proxy on https://*.lvh.me -> tenant plane :7100"

# 2) The console's own Postgres (A5: every record of the console lives in its database). One container, data on the named
#    volume pragmatic-dev-postgres-data, published on host loopback only; its password and the URL file live under
#    $DATA/postgres. The official postgres:17 base of pragmatic-postgres (one database needs no reconcile);
#    switch to ghcr.io/pragmatic-tech-ai/pragmatic-postgres once a platform release carries it.
PG_DIR="$DATA/postgres"
mkdir -p "$PG_DIR"
[ -s "$PG_DIR/password" ] || head -c 32 /dev/urandom | base64 | tr -d '+/=
' > "$PG_DIR/password"
PG_DIR_WIN="$(cd "$PG_DIR" && pwd -W)"
if ! docker ps --format '{{.Names}}' | grep -qx pragmatic-dev-postgres; then
	docker rm -f pragmatic-dev-postgres >/dev/null 2>&1 || true
	MSYS_NO_PATHCONV=1 docker run -d --name pragmatic-dev-postgres --restart unless-stopped 		-p 127.0.0.1:55433:5432 		-e POSTGRES_USER=platform_admin -e POSTGRES_DB=platform_admin -e POSTGRES_PASSWORD_FILE=/run/secrets/password 		-v "${PG_DIR_WIN}/password:/run/secrets/password:ro" 		-v pragmatic-dev-postgres-data:/var/lib/postgresql/data 		postgres:17.12-trixie >/dev/null
fi
until docker exec pragmatic-dev-postgres pg_isready --host=127.0.0.1 --quiet; do sleep 1; done
printf 'postgres://platform_admin:%s@127.0.0.1:55433/platform_admin
' "$(cat "$PG_DIR/password")" > "$PG_DIR/platform-admin.url"
export PRAGMATIC_ADMIN_DATABASE_URL_FILE="$PG_DIR/platform-admin.url"
echo "[dev-up] postgres on 127.0.0.1:55433 (database platform_admin)"

# 3) A data folder from before the database: imported once (the JSON files stay as they are). Exit 3 = the database
#    already holds the records (imported earlier, or written by the console since): nothing to do.
if [ -f "$DATA/master.key" ] && { [ -d "$DATA/identity" ] || [ -f "$DATA/clients.json" ]; }; then
	(cd "$ADMIN" && npx tsx src/bin/pragmatic-admin-import.ts --data-root "$DATA") || [ $? -eq 3 ]
fi

# 4) The console (role admin): operator :7000 + tenant plane :7100 (bind 0.0.0.0 so the Caddy container can reach it),
#    serving pragmatic-tenant-admin's tenant portal. No agent channel: run pragmatic-platform-edge beside it for that.
export PRAGMATIC_CONTROL_PLANE_ROLE=admin
export PRAGMATIC_ADMIN_PORT=7000
export PRAGMATIC_ADMIN_OPERATOR_EMAIL='admin@control-plane.test'
export PRAGMATIC_ADMIN_OPERATOR_PASSWORD='dev-admin-pw'
export PRAGMATIC_ADMIN_SECURE_COOKIE=false
export PRAGMATIC_TENANT_ADMIN_PORT=7100
export PRAGMATIC_TENANT_ADMIN_BIND=0.0.0.0
export PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN=lvh.me
export PRAGMATIC_TENANT_ADMIN_EXTERNAL_SCHEME=https
export PRAGMATIC_TENANT_PORTAL_DIR="$TENANT_ADMIN/tenant-portal/dist"
echo "[dev-up] starting the platform admin console (operator http://127.0.0.1:7000, tenant plane :7100)"
cd "$ADMIN"
exec npx tsx src/server.ts
