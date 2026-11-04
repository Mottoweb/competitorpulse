# CompetitorPulse

CompetitorPulse tracks competitor product listings over time. It polls each competitor's listing, stores every snapshot, asks an LLM to explain in plain English what changed, and shows the history in a small React UI.

## Quick start

You need Docker.

```bash
cp .env.example .env
docker compose up --build
```

Open http://localhost:3000 and add `acme-crm`, `north-analytics` or `ferry-pay`. Compose polls every 30 seconds, so a timeline fills up within a couple of minutes.

The example `.env` uses only the mock LLM, so this costs nothing. **If your `.env` holds a real provider key, that provider is called and billed.**

## Which LLM it uses

DeepSeek is the primary provider, and other providers take over when a call fails. The provided mock server also works, with no key and no cost, and it's what the example `.env` uses.

| To run with | Do this |
|---|---|
| The mock | Nothing: `.env.example` already sets `MOCK_API_KEY` |
| DeepSeek | Set `DEEPSEEK_API_KEY` in `.env` |
| Another provider | Set its key: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY` or `XAI_API_KEY` |

A provider is available only if its key is set. The default order is DeepSeek, OpenAI, Anthropic, Gemini, Mistral, Groq, xAI, mock, and `LLM_PROVIDER_ORDER` changes it. The app logs the order at startup and refuses to start with no provider.

If you add a real key, remove `MOCK_API_KEY` from `.env`. While it's set the mock stays on as the last fallback, and a real provider's failure can store its echo text as a finished summary. Compose always runs the mock's container, but the app only uses it while that key is set.

### Which real providers were tested

- **DeepSeek:** run with a real key and confirmed by the developer.
- **OpenAI, Anthropic, Gemini, Mistral, Groq and xAI:** never called. Their code ran only against local stand-in servers. The default model names may be out of date, and each can be overridden with `<PROVIDER>_MODEL`.

Automated tests never call a real provider.

## Run it without compose for the app

You need Node 22 or later, `python3`, and a Postgres 16 database. The steps below use compose for the database only; to use your own, set `POSTGRES_*` in `.env` to match it.

```bash
cp .env.example .env
npm ci
docker compose up -d db
npm run migration:run -w @competitor-pulse/server
npm run build
python3 files/mock-llm/mock-llm-server.py     # in a second terminal, unless you set a real key
npm start -w @competitor-pulse/server
```

Open http://localhost:3000. Without compose, polling uses the production default of every 15 minutes, though a new competitor is polled straight away. Set `POLL_INTERVAL_SECONDS=30` in `.env` to see changes sooner.

## How it works

```text
 ┌──────────────┐
 │ React UI     │  refetches the timeline every 5s
 └──────┬───────┘
        │ HTTP
┌───────▼──────────────────────────────────────────┐
│ NestJS app (one or more instances)               │
│                                                  │
│  ┌───────┐   ┌──────────────┐  ┌──────────────┐  │
│  │ API   │   │ Poll worker  │  │ Summary      │  │
│  │       │   │ 15s check    │  │ worker       │  │
│  │       │   │              │  │ 15s check    │  │
│  │       │   │              │  │ + failover   │  │
│  └───┬───┘   └──┬───────┬───┘  └──┬────────┬──┘  │
└──────┼──────────┼───────┼─────────┼────────┼─────┘
       │     fetch│       │claim    │claim   │call
       │          ▼       │+ save   │+ save  ▼
       │   ┌───────────┐  │         │  ┌─────────────────┐
       │   │ Data      │  │         │  │ DeepSeek →      │
       │   │ source    │  │         │  │ other providers │
       │   │ (stub)    │  │         │  │ with keys       │
       │   └───────────┘  │         │  └─────────────────┘
┌──────▼──────────────────▼─────────▼──────────────┐
│ Postgres: source of truth and work queue         │
│ competitors, snapshots, source_cursors           │
└──────────────────────────────────────────────────┘
```

1. Every check, the poll worker claims due competitors with `FOR UPDATE SKIP LOCKED` and moves `next_poll_at` forward in the same short transaction.
2. It fetches the listing with no transaction open.
3. In one short transaction, it compares content hashes and saves the snapshot. An unchanged or first snapshot gets `changed = false` and never reaches the LLM. A changed one gets `changed = true` and `summary_status = 'pending'`.
4. The summary worker claims pending rows and sets a retry time, so a crash brings the row back.
5. It calls the LLM with a 30-second timeout. A failed attempt backs off and moves to the next available provider.
6. It saves the summary on the same snapshot row, or marks it `failed` once attempts run out. The snapshot itself is never at risk.
7. The API returns the snapshot and its summary together.

**Tech stack:** NestJS 11, TypeScript and Node 22; Postgres 16 with TypeORM and generated migrations; React 19, Vite, `react-router`, Tailwind 4 and shadcn/ui; `@nestjs/swagger`, `openapi-typescript` and `openapi-fetch` for the API contract; Docker and compose.

There's no Redis or BullMQ: Postgres is both the store and the work queue, so a snapshot and its pending summary commit together.

## Assumptions

- The stub advances one version per successful poll and stores its position in Postgres, so a failed save can't skip a version and a restart can't cause a false change.
- The first snapshot has nothing to compare with, so it counts as unchanged and makes no LLM call.
- A competitor is due immediately after it's added.
- Removing a competitor deletes its snapshots and position, so adding it again starts at version 1.
- Removing a competitor during a poll drops that poll's result, even if the competitor is added again before the poll finishes.
- A competitor id is 1 to 100 lowercase letters, digits and single hyphens, and must exist in the fixtures.
- As the brief allows, there are no user accounts or auth.

## API

Swagger UI is at `/api/docs`, and its document at `/api/docs-json`. The committed spec, `server/openapi.json`, is the one contract between server and web.

| Request | Success | Errors |
|---|---|---|
| `GET /api/competitors` | 200, `[{ "id": string }]` sorted by id | |
| `POST /api/competitors` with `{ "id": string }` | 201, `{ "id": string }` | 400 malformed id, 409 already tracked, 422 unknown to the source |
| `DELETE /api/competitors/:id` | 204 | 404 not tracked |
| `GET /api/competitors/:id/snapshots` | 200, snapshots newest first | 400 invalid `limit`, 404 not tracked |
| `GET /healthz` | 200, `{ "status": "ok" }` | 503, `{ "status": "unavailable" }` if Postgres is unreachable or doesn't answer within 2 seconds |

The `/api/competitors` endpoints also answer 503 while Postgres is unavailable, and 500 for any other unexpected error.

**Added beyond the brief:**
- `summaryStatus` (`none`, `pending`, `done` or `failed`), `summaryProvider` and `summaryModel` on `Snapshot`.
- An optional `?limit=` on snapshots, returning the full history without it.
- `GET /healthz`.

## Configuration

Settings come from the environment, and locally from the repo root's `.env`. Real environment variables win over the file. Integration tests never read `.env`.

| Variable | Default | Required | What it does |
|---|---|---|---|
| `POSTGRES_HOST` | none | Yes | Database host. Compose sets `db` for the app |
| `POSTGRES_PORT` | none | Yes | Database port. Under compose it's the port published on the host's localhost; the app always uses 5432 inside the network |
| `POSTGRES_USER` | none | Yes | Database user |
| `POSTGRES_PASSWORD` | none | Yes | Database password |
| `POSTGRES_DB` | none | Yes | Database name |
| `PORT` | `3000` | No | API port. Under compose it's the port published on the host |
| `LOG_SQL` | `false` | No | `true` logs every SQL query |
| `WEB_DIST_DIR` | `web/dist` | No | The built web app's folder. Compose sets it |
| `POLL_INTERVAL_SECONDS` | `900` (`30` under compose) | No | How often each competitor is polled, with about 10% jitter |
| `CHECK_INTERVAL_SECONDS` | `15` (`5` under compose) | No | How often the workers look for due work |
| `<PROVIDER>_API_KEY` | none | At least one | Enables that provider: `DEEPSEEK`, `OPENAI`, `ANTHROPIC`, `GEMINI`, `MISTRAL`, `GROQ`, `XAI` or `MOCK` |
| `<PROVIDER>_MODEL` | See `server/src/llm/providers.ts` | No | Overrides the provider's model |
| `<PROVIDER>_BASE_URL` | See `server/src/llm/providers.ts` | No | Overrides the provider's URL. Compose points `MOCK_BASE_URL` at the mock service |
| `LLM_PROVIDER_ORDER` | All eight, DeepSeek first and mock last | No | Comma-separated order, which is also an allow-list |
| `LLM_MAX_ATTEMPTS` | `3`, or the number of available providers if higher | No | The most attempts per summary |

## Development

```bash
docker compose up -d db                        # the database only
npm run migration:run -w @competitor-pulse/server
python3 files/mock-llm/mock-llm-server.py      # in its own terminal, unless you set a real key
npm run start:dev -w @competitor-pulse/server  # restarts on source changes, not on .env changes
npm run dev -w @competitor-pulse/web           # Vite on http://localhost:5173
```

The Vite dev server proxies `/api` and `/healthz` to `http://localhost:3000`, so run the server on the default port. Vite serves the web app, and the server only serves `web/dist` once it's built.

### Common tasks

| Command | Runs | Needs |
|---|---|---|
| `npm run test:unit` (also `npm test`) | Server and web unit tests | Nothing |
| `npm run test:integration` | Integration tests, on a throwaway `postgres:16` from Testcontainers | Docker, `python3` |
| `npm run test:all` | Types, lint, unit and integration tests | Docker, `python3` |
| `npm run test:compose` | The full compose stack from a temporary copy of the repo, using only `.env.example`: restarts, a stop during an LLM call, a crash-style exit, and Postgres stopped and frozen. Takes a few minutes and isn't part of `test:all`. CI runs it as its own job | Docker |
| `npm run typecheck`, `npm run lint` | Each check alone | Nothing |

Tests never touch your dev database or your `.env`.

**Migrations.** Change an entity, then generate, review and run a migration. `synchronize` is off everywhere.

```bash
npm run migration:generate -w @competitor-pulse/server -- migrations/AddSomething
npm run migration:run -w @competitor-pulse/server
npm run migration:revert -w @competitor-pulse/server
```

**API contract.** After changing a controller or DTO, run `npm run openapi:generate`. It rewrites `server/openapi.json` and `web/src/generated/api.ts`, needs no database, and tests fail if either is out of date.

**UI components.** shadcn/ui components are source files in `web/src/components/ui/`. To add one, run `npx shadcn@latest add <name>` from `web`.

## Project layout

| Path | Holds |
|---|---|
| `server/src/competitors/` | API controller, service, DTOs and contract types |
| `server/src/source/` | `ListingSource` interface, fixture stub and cursor entity |
| `server/src/poller/` | Poll worker, content hash, snapshot entity and queries |
| `server/src/summarizer/` | Summary worker, prompt and status queries |
| `server/src/llm/` | Provider table, clients and failover |
| `server/src/database/` | TypeORM configuration |
| `server/src/health/` | `GET /healthz` |
| `server/src/openapi/` | Swagger setup and spec generation |
| `server/src/web/` | Serves the built web app |
| `server/src/testing/` | Test helpers and the compose check |
| `server/migrations/` | Database migrations |
| `web/src/` | `CompetitorList`, `Timeline` and the API client |
| `web/src/generated/` | Types generated from the spec |
| `files/` | Provided fixtures and mock LLM |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `No LLM provider is available: set an API key such as DEEPSEEK_API_KEY` | No provider key is set, or `LLM_PROVIDER_ORDER` excludes every key you set. Set a key in `.env`; `MOCK_API_KEY=mock` works with the mock |
| `Invalid database configuration: POSTGRES_HOST, ...` | Those variables are missing or invalid. Run `cp .env.example .env` |
| `Set POSTGRES_USER in .env, see .env.example` | Compose found no `.env`. Run `cp .env.example .env` |
| `EADDRINUSE` on startup | Port 3000 is in use. Stop the other process or set `PORT` |
| `port is already allocated` from compose | Port 3000 or 5432 is in use on the host. Set `PORT` or `POSTGRES_PORT` in `.env` |
| Summaries stay `pending`, then end up `failed` | The provider can't be reached. Without compose, check that the mock is running. The app's log shows each failed attempt |

## Scale and production notes

The brief's scale, a few hundred competitors polled every 15 minutes, is about 0.33 polls per second.

- **Cost:** the hash check decides whether the LLM runs, so an unchanged listing costs nothing. The separate summary step means a retry repeats only the LLM call, and the attempt cap bounds spend. Delivery is at-least-once, so a crash can repeat a billed call.
- **Parallel work:** claims use `SKIP LOCKED`, so instances don't wait on each other, and no lock is held during a network call. Any instance can do the work, with no leader.
- **Restarts:** the schedule is in Postgres, so polling resumes where it left off and overdue competitors are polled once.
- **Postgres is the one critical dependency.** Production should use managed Postgres with a standby in another zone, automatic failover and point-in-time backups. A brief outage pauses the system, and a poll in progress can lose its snapshot if its write retries run out.
- **Growth:** the first real limit is snapshot volume, about 10M rows a year at 300 competitors. The next step is time partitioning and a retention policy, with a dedicated queue only if volume or job types outgrow this design.
- **Before production:** add auth, since Swagger UI and the API are open. Lower the per-poll log line to debug level.

## Known limits

**Behaviour**
- The default attempt cap covers only a short outage: with one provider, 3 attempts span about 15 seconds. A summary marked `failed` is never retried, so changes detected during a longer outage stay `failed`. This is the cost of bounding spend.
- The prompt caps each listing field at 2,000 characters, so a change past the cap is detected and stored but the LLM can't see it, and its summary may be vague or wrong. The stub's fields are far shorter, so this can't happen today. A real fetcher should send an excerpt around the change.
- A slow LLM call holds its batch: the next claim waits for the whole batch, for up to the 30-second timeout.
- The web app trusts its generated types at run time, so a response that breaks the spec reaches the UI unchecked.
- A web request is abandoned after 15 seconds, so a hung request pauses that timeline's refetching for up to that long.
- Idle checks log nothing, so a quiet log can look like a stopped worker.

**Not tested**
- More than one app instance under compose, though concurrent claims are tested against real Postgres.
- The restart policy after a hard crash. The compose check makes the process exit on SIGTERM, because a signal sent from inside can't SIGKILL PID 1, and `docker kill` counts as a manual stop.
- A stop during an LLM call that takes longer than the 40-second grace period.
- The pending and failed badges in a real browser. Web tests cover their text, not their appearance.

**Open**
- Headless Chromium sometimes reports a successful `DELETE` as failed, with `net::ERR_ABORTED`. The competitor is removed and the UI shows no error. The cause is unknown.
- 32 low and moderate `npm audit` findings remain in dev tooling and are accepted. The production image has no dev dependencies.

## AI tools used

The system was built with Claude Code. The design was discussed thoroughly first and written up as a plan. Each plan step was then carried out with a human in the loop, who reviewed and adjusted the work before it was merged.
