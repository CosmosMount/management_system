# Systemd service deployment

This directory contains systemd unit templates and helper scripts for running the project without Docker.

## Install and start

Run from the repository root:

```bash
npm ci
npm run build
```

Then install and start the services:

```bash
./service/install.sh
```

The script automatically detects:

- project directory
- service user and group
- `node` / `npm` absolute paths
- `APP_PORT` from `.env` and maps it to systemd `PORT`
- `.env` values required by the app

It renders and installs:

- `pnx-management-server.service`
- `pnx-management-cron.service`

Then it runs `systemctl daemon-reload`, enables both services, and starts them.

The web service runs `npm run db:push` before `npm start`, so database schema sync happens during service startup. It does not run `npm run build`; build the app before installing or restarting the service after code changes.

If the current user needs sudo and cannot use passwordless sudo, set `SUDO_PASSWORD` in `.env` or in the shell before running the script. The generated runtime env file excludes `SUDO_PASSWORD`.

## Dry run

To render files without installing services:

```bash
DRY_RUN=true ./service/install.sh
```

Rendered files are written to `/tmp/pnx-management-service-dry-run` by default.

## Uninstall

```bash
./service/uninstall.sh
```

The uninstall script stops and disables both services, removes the unit files, and keeps `/etc/pnx-management/pnx-management.env`.

To remove the generated runtime env file as well:

```bash
REMOVE_ENV_FILE=true ./service/uninstall.sh
```

Application data in the repository, SQLite database files, and uploaded files are not removed.
