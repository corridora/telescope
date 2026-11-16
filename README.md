# Telescope

A cross-browser web performance testing toolkit built on [Playwright](https://playwright.dev/). This repository is a monorepo containing two packages:

| Package                                              | Description                                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`packages/telescope`](./packages/telescope)         | Core CLI and library (`@cloudflare/telescope`)                                           |
| [`packages/telescope-web`](./packages/telescope-web) | Web app for uploading and viewing results ([telescopetest.io](https://telescopetest.io)) |

---

## packages/telescope

A TypeScript CLI and Node.js library that launches real browsers, collects performance data, and saves results locally.

**Supported browsers:** Chrome, Chrome Beta, Chrome Canary, Edge, Firefox, Safari (WebKit)

**What it collects per test:**

- HAR file (`pageload.har`)
- Web Vitals and performance metrics (`metrics.json`)
- Console output (`console.json`)
- Resource timing data (`resources.json`)
- Screenshot (`screenshot.png`)
- Filmstrip and video of the page load

### Quick start

Install from npm:

```bash
npm install -g @cloudflare/telescope
telescope -u https://example.com -b chrome
```

The `postinstall` script automatically downloads Playwright's browser binaries (~700MB).

Or from a clone of this repo:

```bash
npm install
npm run build -w packages/telescope
npm link                          # registers `telescope` globally
telescope -u https://example.com -b chrome
```

See [`packages/telescope/README.md`](./packages/telescope/README.md) for full documentation.

Start the local run/results UI with a persistent workspace:

```bash
telescope local --resultsDir ./results
```

The local UI runs tests, saves reusable definitions, imports existing captures,
and displays diagnostic results. Trusted multi-step scripts run with
`telescope -u https://example.com --script ./journey.mjs --zip`.
An outbound `telescope agent` can execute jobs for a local or hosted controller;
the controller retains the accepted result. See the core documentation for
enrollment, target policies, cancellation, and script provisioning.

For container deployments, use the [Docker guide](./packages/telescope/docker/README.md).
It covers a combined UI/runner, split services on one network, and isolated
networks connected through explicit gateways.

---

## packages/telescope-web

The Astro + Cloudflare Workers web application hosted at [telescopetest.io](https://telescopetest.io). Users upload Telescope ZIP results and view an interactive breakdown of metrics, waterfall, filmstrip, console logs, and more.

The web application also initiates tests on enrolled agents, saves their artifacts
on the web instance, and displays multi-step captures. Optional ZIP forwarding
uses a durable outbox while preserving the local result. The
[agent operator guide](./packages/telescope-web/docs/external-agents.md) and web
README describe the administrator setup, migrations, and required secrets.

**Stack:** Astro v7, Cloudflare Workers, D1 (SQLite via Prisma), R2, Workers AI

### Quick start

```bash
cd packages/telescope-web
npm install
npm run dev:setup  # one-time setup: DB, migrations, Prisma client, type generation
npm run dev
```

See [`packages/telescope-web/README.md`](./packages/telescope-web/README.md) for full documentation.

---

## Repository structure

```
packages/
  telescope/          # Core CLI and library
    src/              # TypeScript source
    __tests__/        # Integration tests (Vitest)
    tests/            # Static test fixtures
    processors/       # Standalone HTML report generator
    support/          # Browser support files
  telescope-web/      # telescopetest.io web app
    src/              # Astro pages, components, and server logic
    migrations/       # D1 SQL migrations
    prisma/           # Prisma schema
.github/
  workflows/
    test.yml          # CI: builds and tests packages/telescope on every PR
    deploy.yml        # CD: deploys packages/telescope-web on merge to main
```

## CI

- **`test.yml`** — runs on every push and PR (excluding `packages/telescope-web/**` changes). Builds `packages/telescope` and runs the full browser test suite inside the official Playwright Docker container.
- **`deploy.yml`** — runs on push to `main` when the web app or its shared capture contracts change. Applies D1 migrations, builds, and deploys to Cloudflare Workers.

## npm Releases

We use the `changesets` package to maintain the changelog and publish `@cloudflare/telescope` and `@cloudflare/waterfall` to the npm registry. See [.changeset/README.md](.changeset/README.md) for usage instructions.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
