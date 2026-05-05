# Maverick Linux Server Setup

This repo now includes the files needed to keep Windows as the development box and run Maverick on a separate always-on Linux host.

## What Lives Where

- Windows remains the development machine.
- Linux runs Maverick as a `systemd` service from `/srv/maverick/app`.
- Netwise is cloned to `/srv/maverick/repos/netwise`.
- SyncSonic is cloned to `/srv/maverick/repos/syncsonic`.
- Maverick state lives in `/var/lib/maverick`.

Tracked server assets:

- Linux control-plane config: `config/control-plane.linux.json`
- Linux env example: `deploy/linux/maverick.env.example`
- Linux bootstrap script: `scripts/bootstrap-linux-server.sh`
- Linux service unit: `deploy/systemd/maverick.service`
- Windows first-time bootstrap wrapper: `scripts/bootstrap-linux-server.ps1`
- Windows ongoing deploy script: `scripts/deploy-linux.ps1`
- Windows state tunnel helper: `scripts/start-state-tunnel.ps1`
- Offline state recovery/import helper: `scripts/sync-linux-state.ps1`
- SQLite merge helper: `scripts/merge-state-databases.mjs`

## One-Time Physical Linux Steps

Do these once on the Linux machine itself:

```bash
sudo apt update
sudo apt install -y openssh-server
sudo systemctl enable --now ssh
```

Create your admin user, add it to `sudo`, and add your Windows SSH public key to `~/.ssh/authorized_keys`.

After that, all remaining setup can be driven from Windows over SSH.

## Git Prereqs Before Bootstrap

Before the first bootstrap:

1. Create a private Git remote for Maverick.
2. Add the remote to the local Maverick repo.
3. Push the clean Maverick `main` branch.
4. Push the Netwise epic branches Maverick depends on:
   - `codex/laptop-wifi-scanner-epic`
   - `codex/mobile-wifi-scanner-epic`
   - `codex/router-admin-ingestion-epic`
5. Push SyncSonic `pi-stable-baseline-2026-04-05`.

The Linux host now deploys Maverick directly from `main`.

## First-Time Bootstrap From Windows

Use an SSH host alias such as `maverick-server` in `C:\Users\<you>\.ssh\config`.

The bootstrap script now installs a GitHub SSH key for the Linux `maverick` service user so the server can pull from GitHub directly on its own. By default it copies `C:\Users\<you>\.ssh\id_ed25519` and `C:\Users\<you>\.ssh\id_ed25519.pub`. If you prefer a dedicated deploy key, pass `-GitHubPrivateKeyPath` and `-GitHubPublicKeyPath` explicitly.

Then run:

```powershell
.\scripts\bootstrap-linux-server.ps1 `
  -SshHost maverick-server `
  -MaverickRepoUrl git@github.com:YOUR_USER/Maverick.git
```

The wrapper will:

- render a Linux env file from the local `.env`
- upload and run the Linux bootstrap script
- clone Maverick, Netwise, and SyncSonic
- install Node 20, build tools, SQLite tools, Go, `libpcap` headers for Netwise, and Codex
- install and enable the `maverick` `systemd` service
- leave Linux as the canonical SQLite owner at `/var/lib/maverick`
- start Maverick and run a localhost health check

If you explicitly need to import the local SQLite file during first-time recovery work:

```powershell
.\scripts\bootstrap-linux-server.ps1 `
  -SshHost maverick-server `
  -MaverickRepoUrl git@github.com:YOUR_USER/Maverick.git `
  -ImportLocalDatabase
```

Routine Windows/Linux operation should not copy SQLite files. Windows should use the Linux-owned state API through the SSH tunnel below.

## Shared State Model

Linux owns the SQLite file directly:

```dotenv
MAVERICK_ROLE=server
MAVERICK_INSTANCE_ID=linux
STATE_BACKEND=sqlite
DATABASE_PATH=/var/lib/maverick/orchestrator.db
MAVERICK_STATE_TOKEN=<same-long-secret-on-linux-and-windows>
```

The HTTP server is already bound to `127.0.0.1` by default in the shared control-plane config. The internal state API is only enabled when `MAVERICK_STATE_TOKEN` is set.

Windows keeps the existing Discord command routing and instance behavior, but uses the Linux state service.

**SSH tunnel (legacy / local-forward):**

```dotenv
MAVERICK_ROLE=client
MAVERICK_INSTANCE_ID=windows
STATE_BACKEND=remote
MAVERICK_STATE_URL=http://127.0.0.1:3848
MAVERICK_STATE_TOKEN=<same-long-secret-on-linux-and-windows>
```

Start the tunnel before starting the Windows bot:

```powershell
.\scripts\start-state-tunnel.ps1 -SshHost maverick-server
```

This forwards `127.0.0.1:3848` on Windows to the Linux service on `127.0.0.1:3847`. If the tunnel or Linux state API is unavailable, Windows remote state calls fail closed instead of opening its own SQLite database.

In client role, Windows does not start the Discord bot, assistant reminder workers, or background worktree reaper. To dogfood a local Windows build against Discord, temporarily stop the Linux service and run Windows with `MAVERICK_ROLE=server`; switch it back to `client` when the Linux service resumes.
**Cloudflare Tunnel + Access (hosted state hostname):**

Point `MAVERICK_STATE_URL` at the public state host (no path suffix; the client appends `/internal/state/operation`). When that hostname sits behind Cloudflare Access **service authentication**, set the Access client id/secret so every remote state POST includes the required headers:

```dotenv
MAVERICK_INSTANCE_ID=windows
STATE_BACKEND=remote
MAVERICK_STATE_URL=https://maverick-state.example.com
MAVERICK_STATE_TOKEN=<same-long-secret-as-linux-MAVERICK_STATE_TOKEN>
CLOUDFLARE_ACCESS_CLIENT_ID=<service-token-client-id>
CLOUDFLARE_ACCESS_CLIENT_SECRET=<service-token-client-secret>
```

Linux canonical instance should keep `STATE_BACKEND=sqlite`, set `DATABASE_PATH`, and enable `MAVERICK_STATE_TOKEN` so Linux accepts `POST /internal/state/operation` from Windows. The command center UI should call the **dashboard** host for `/api/dashboard/*`, not the state host.

When the dashboard API is exposed on a public hostname (for example `https://maverick.example.com`), Maverick also serves the bundled command center at **`/command-center.html`** (and redirects **`/`** there) from the `public/` directory shipped with the app. Set `MAVERICK_DASHBOARD_ALLOWED_ORIGIN` to that same origin (scheme + host only) if the browser loads the UI from that hostname and uses credentialed fetches.

## State Migration

For the first shared-state migration:

1. Stop both bots.
2. Back up both SQLite files, including matching `-wal` and `-shm` files.
3. Apply the new schema on Linux with `npm run db:migrate`.
4. Merge Windows-only rows into the Linux database:

```powershell
node .\scripts\merge-state-databases.mjs `
  --canonical C:\path\to\linux\orchestrator.db `
  --source C:\Users\wimer\Desktop\Maverick\data\orchestrator.db `
  --report .\maverick-state-merge-report.json
```

The merge script keeps Linux rows on duplicate primary keys, imports missing rows, remaps conflicting event ids so source events are not lost, and converts legacy `workstreams.cwd` / `workstreams.codex_thread_id` values into per-instance `workstream_runtime_bindings`.

## Ongoing Deploys From Windows

Deploy the current `main` branch to Linux with:

```powershell
.\scripts\deploy-linux.ps1 -SshHost maverick-server
```

By default the deploy script:

- runs local `npm test`
- runs local `npm run build`
- pushes `main`
- SSHes into Linux
- updates the Linux clone
- runs `npm ci --include=dev`
- rebuilds Maverick
- restarts `systemd`
- checks `http://127.0.0.1:3847/health`

## Dogfooding Maverick Self-Updates

Changes made in the local Windows Maverick repo do not automatically reach the live Linux bot.
Until you deploy, Discord is still talking to whichever Maverick instance is currently running.

When testing Maverick changes that affect Discord routing, workstream creation, approvals, or other operator-facing behavior:

1. Stop or disable the Linux Maverick service first so Discord traffic does not hit stale server code during the test.
2. Run Maverick locally on Windows from the branch you are validating.
3. Use the real Discord interface as the integration test surface.
4. Validate the specific behavior you changed, not just local build/test output.
5. Stop the Windows Maverick process after validation so there is only one active Discord-connected Maverick instance again.
6. Then deploy the validated branch to Linux and restart the Linux Maverick service.

Restarting the `systemd` service is the normal path.
Reboot the Linux host only when the change actually requires a full machine restart.

## Offline State Recovery

Do not use SQLite copying for routine state sharing. The sync script is retained for explicit offline recovery/import only, after stopping the local bot and the Linux service:

```powershell
.\scripts\sync-linux-state.ps1 -SshHost maverick-server
```

The state sync script refuses to run if it detects a local Maverick Node or `tsx` process. Stop local Maverick first so the SQLite copy is consistent.
