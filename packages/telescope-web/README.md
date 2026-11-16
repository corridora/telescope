# telescope-web

The web application for [telescopetest.io](https://telescopetest.io) — upload and view [`@cloudflare/telescope`](../telescope) test results in an interactive UI. Built with Astro and hosted on Cloudflare Workers.

Part of the [`cloudflare/telescope`](https://github.com/cloudflare/telescope) monorepo. Lives at `packages/telescope-web/`.

## Stack

- **Astro v7** with `@astrojs/cloudflare` adapter
- **Cloudflare Workers** (D1, R2, AI bindings)
- **Prisma v7** with `@prisma/adapter-d1` for D1 (SQLite)
- **React v19** for interactive components
- Node.js 24+ required

## Project Setup

To set up for local development, install dependencies and run the one-time setup script from `packages/telescope-web/`:

```bash
cd packages/telescope-web
npm install
```

Then initialize a few things:

- create local database (will prompt you to confirm that you want to perform the DB migrations)
- generate Prisma client (in `generated/prisma` folder)
- create R2 bucket (might prompt you to log into your Cloudflare account)
- generate TypeScript types to match wrangler configuration (`worker-configuration.d.ts`)

To accomplish all that, you can simply run:

```
npm run dev:setup
```

You should now be able to use the application and run `npm run studio` to view local D1 data in Prisma Studio and create migrations.

## Running Locally

Run `npm run dev` to view the site with Astro's hot reload (instantly reflect changes) using the adapter for Cloudflare.

## DB Migrations

We use Prisma to generate SQL for migrations, and Wrangler to apply them. Prisma migrate does not fully support D1 yet, so you cannot follow the default prisma migrate workflows. Instead, migration need to be done as follows:

#### Normal Use

1. Make your edits to `prisma/schema.prisma`.
2. Run `npx wrangler d1 migrations create telescope-db-development {{describe_changes_here}} --env development`. This should create an empty SQLite file with a comment at the top.
3. Run

```
npx prisma migrate diff \
  --from-config-datasource \
  --to-schema ./prisma/schema.prisma \
  --script \
  --output migrations/{{file_created_by_previous_step}}.sql
```

This should fill your created file with the raw SQLite for your changes.

4. Run `npm run generate` to regenerate a Prisma Client that reflects your new changes in `schema.prisma`.
5. Run `npm run migrate:development` to apply this new migration to your local database.

### Note about Workers AI (AI content review)

One thing to note is that telescope-web uses Workers AI for AI content review on uploads. Workers AI _always_ uses tokens that can incur costs, even in local/remote testing. AI content review is disabled locally by default. You can optionally enable AI content review (which may start costing money) by running the command `cp .dev.vars.example .dev.vars` and setting `ENABLE_AI_RATING=true`.

## Testing in Staging

Staging allows you to test changes in a remote environment that isn't production. To deploy to staging, run `npm run deploy:staging`. This command will only work if you have permission to deploy to telescope-web's remote Worker.

## Deployment to Production

Changes to the production website should only be deployed on Cloudflare workers on successful PR into @cloudflare/telescope. To run this deployment, we have a GitHub workflow `.github/workflows/deploy.yml`. This is what that workflow does:

1. Checks out code
2. Installs Node.js 24
3. Installs project dependencies
4. Applies any new D1 migrations
5. Generates Prisma client
6. Builds project (generates `dist/`)
7. Deploys project (uploads `dist/` to Cloudflare)

Once successful, the deployed site can be found on [telescopetest.io](telescopetest.io).

## Forwarding uploaded ZIPs

Forwarding keeps the locally saved result and sends an additional copy of the
**exact original ZIP** to one administrator-configured URL. It is disabled by
default. Original archives may contain entries ignored by the results renderer;
forwarding does not sanitize or reconstruct them.

Apply migration `0005_upload_forwarding.sql` with the other application
migrations. Configure `TELESCOPE_ADMIN_TOKEN` for the administration session, a
stable `TELESCOPE_INSTANCE_ID` (8–128 letters, digits, `_` or `-`),
`UPLOAD_FORWARD_URL`, and `UPLOAD_FORWARD_ENABLED=true`. The upload workflow must
retain the original ZIP and call `scheduleForward()` before local publication;
its worker only claims deliveries after the local result is committed.

`UPLOAD_FORWARD_LABEL` is the safe display name. `UPLOAD_FORWARD_MODE=http`
accepts a 2xx response as HTTP acceptance, including asynchronous `202` replies;
it does not claim the remote system durably stored the archive. The optional
`telescope` mode requires a JSON receipt with `success:true` and a matching
`zipKey`/`sha256`/`archiveSha256` or `deliveryId`. A matching `409` duplicate receipt
must also contain `duplicate:true`. Only `publicationState:'committed'` in a
non-202 Telescope receipt confirms remote durable publication.

Forward requests use multipart POST with `file`, `source`, and optional `name`
and `description`. `Idempotency-Key` and `X-Telescope-Forward-Id` retain the same
delivery UUID on retries; `X-Telescope-Archive-SHA256` identifies the ZIP bytes.
The receiver's filename is sanitized. Browser cookies, incoming authorization,
and caller-provided headers are never copied. Put a receiver-specific bearer
credential in `UPLOAD_FORWARD_BEARER_TOKEN` when required.

Cooperating instances can share `UPLOAD_FORWARD_PEER_SECRET`. The sender signs
the delivery ID, archive checksum, and instance chain using HMAC-SHA256. Only
verified forwarded provenance suppresses automatic onward forwarding; untrusted
client headers do not. Configure `TELESCOPE_INSTANCE_ORIGINS` with public and
internal aliases so self-targets are rejected. Receiver-side archive deduplication
and the stable idempotency key remain necessary: a timed-out request may already
have been accepted, and generic endpoints cannot guarantee exactly-once delivery.

HTTPS with certificate verification is required by default. Explicit local
exceptions are `UPLOAD_FORWARD_ALLOW_HTTP=true` and
`UPLOAD_FORWARD_ALLOW_PRIVATE=true`; they do not override the runtime's outbound
network restrictions. The current hosted runtime's public-fetch policy may still
prevent private-network destinations. No redirects are followed, so credentials
cannot be sent to an unexpected redirect origin.

### Durable processing and administration

The application's Worker scheduled entry point reconciles the durable outbox
using the configured cron trigger. Upload-request wake-ups reduce initial
latency; they are not the retry mechanism. Custom installations can instead
POST `/api/forwarding/process` regularly using
`Authorization: Bearer <UPLOAD_FORWARD_SCHEDULER_TOKEN>`. That separately scoped
secret permits processing due work only. An administrator token can also process
work. Each invocation performs a bounded batch and reconciles expired leases,
review eligibility, expiry, and cleanup. The callable integration is
`processForwarding(undefined, bindings, batchSize)`. Deploy and configure the
scheduler with the application; no deployment or runtime verification is implied
by these source changes.

Visit `/forwarding` and sign in using the instance administrator token. It shows
delivery state, attempt history, retained bytes, safe receipt information, and
retry/pause/resume/cancel controls. The original ZIP and destination credentials
are never exposed there. All administration responses use private no-store
caching. `/api/forwarding/status` exposes only an enabled flag and destination
label for upload disclosure.

Defaults are a 15-second request timeout, six automatic attempts, a one-day source
retention age, a 32 MiB archive limit, and a 1 GiB retained-source budget. Retryable
connection failures, `408`, `429`, and `5xx` use bounded backoff and jitter.
`Retry-After` is bounded. An explicit operator retry starts a new automatic retry
budget while preserving the delivery identity and previous attempts.

When instance content rating is enabled, delivery waits for an allowed rating;
unsafe results are blocked. Review that does not complete reaches the same
configured source-expiry deadline instead of remaining queued indefinitely.
Accepted originals default to immediate cleanup. Blocked, expired, failed, and
cancelled sources default to one further day of retention; all retention and
quota settings are listed in `.dev.vars.example`. Retention affects only the
private transfer source, never the locally rendered capture artifacts. Retrying
after source cleanup is explicitly unavailable.

Changing destination, review policy, or `UPLOAD_FORWARD_CONFIG_VERSION` pauses older deliveries;
they are never silently redirected. Restore the original configuration and
explicitly resume/retry an older delivery when appropriate. Bearer-token rotation
updates the secret reference in place. Disabling forwarding pauses unsent work;
it does not retract bytes from an in-flight or already accepted request.

Forwarding from the hosted upload workflow is separate from remote-agent artifact
delivery. It does not generate ZIPs for file-by-file agent uploads or delay the
agent's acknowledgment of a locally committed result.

The installed local server has a filesystem-backed adapter with the same
destination, authentication, receipt, retry, review, and retention settings. It
retains sources and delivery records under `.telescope/forwarding` and reconciles
them for the local-server lifetime. Only ZIP imports create forwarding intents;
new local browser runs are not implicitly exported and forwarded. Local API
controls live under `/api/local/forwarding/` and use the local session boundary.
The local adapter's prepare hook runs before atomic import publication, so an
accepted import does not depend on a successful outbound request. If local
content rating is explicitly enabled, the adapter waits for a trusted allowed
rating and otherwise expires at its configured deadline.
