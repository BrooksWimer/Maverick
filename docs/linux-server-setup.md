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
- Windows state sync script: `scripts/sync-linux-state.ps1`

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
3. Push the clean Maverick `master` baseline.
4. Push a dedicated Maverick `server` branch for the Linux host.
5. Push the Netwise epic branches Maverick depends on:
   - `codex/laptop-wifi-scanner-epic`
   - `codex/mobile-wifi-scanner-epic`
   - `codex/router-admin-ingestion-epic`
6. Push SyncSonic `pi-stable-baseline-2026-04-05`.

`master` stays clean and is not used as the Linux deploy branch. The Linux host pulls Maverick from `server` by default.

## First-Time Bootstrap From Windows

Use an SSH host alias such as `maverick-server` in `C:\Users\<you>\.ssh\config`.

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
- install Node 20, build tools, SQLite tools, and Codex
- install and enable the `maverick` `systemd` service
- sync the local SQLite state to `/var/lib/maverick`
- start Maverick and run a localhost health check

If you want to bootstrap without copying the SQLite state yet:

```powershell
.\scripts\bootstrap-linux-server.ps1 -SshHost maverick-server -MaverickRepoUrl git@github.com:YOUR_USER/Maverick.git -SkipDatabaseSync
```

## Ongoing Deploys From Windows

Deploy the current `server` branch to Linux with:

```powershell
.\scripts\deploy-linux.ps1 -SshHost maverick-server
```

By default the deploy script:

- runs local `npm test`
- runs local `npm run build`
- pushes `server`
- SSHes into Linux
- updates the Linux clone
- runs `npm ci --include=dev`
- rebuilds Maverick
- restarts `systemd`
- checks `http://127.0.0.1:3847/health`

## Re-Syncing State Later

To re-copy the local SQLite state:

```powershell
.\scripts\sync-linux-state.ps1 -SshHost maverick-server
```

The state sync script refuses to run if it detects a local Maverick Node or `tsx` process. Stop local Maverick first so the SQLite copy is consistent.
