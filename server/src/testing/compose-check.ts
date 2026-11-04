import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

// Brings the real compose stack up from a copy of the repo with only
// .env.example as its .env, the same as a clean checkout. The developer's .env
// isn't copied, so no real provider key can reach the stack.

const REPO_ROOT = join(__dirname, '../../..');
const PROJECT = 'competitor-pulse-check';
const COMPETITOR = 'acme-crm';
const SLOW_COMPETITOR = 'north-analytics';
const FIXTURE_CHANGES = 3;
const SIGKILL_EXIT_CODE = 137;

const serviceStateSchema = z.object({
  Service: z.string(),
  State: z.string(),
  Health: z.string(),
  ExitCode: z.number(),
});
type ServiceState = z.infer<typeof serviceStateSchema>;

const snapshotsSchema = z.array(
  z.object({
    changed: z.boolean(),
    summary: z.string().nullable(),
    summaryStatus: z.string(),
    summaryProvider: z.string().nullable(),
  }),
);
type Snapshots = z.infer<typeof snapshotsSchema>;

const composeConfigSchema = z.object({
  services: z.object({
    db: z.object({
      ports: z.array(z.object({ host_ip: z.string().optional() })),
    }),
    app: z.object({ environment: z.record(z.string(), z.string().nullable()) }),
  }),
});

function check(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Check failed: ${message}`);
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') {
          reject(new Error('Could not find a free port'));
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

function copyCleanCheckout(): string {
  const listed = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  check(listed.status === 0, 'git could list the repo files');

  const target = mkdtempSync(join(tmpdir(), `${PROJECT}-`));
  for (const file of listed.stdout.split('\0').filter(Boolean)) {
    cpSync(join(REPO_ROOT, file), join(target, file), { recursive: true });
  }
  copyFileSync(join(target, '.env.example'), join(target, '.env'));
  return target;
}

class Stack {
  constructor(
    private readonly directory: string,
    private readonly appUrl: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  /** Runs a compose command and shows its output as it goes. */
  run(...args: string[]): boolean {
    const result = spawnSync('docker', ['compose', '-p', PROJECT, ...args], {
      cwd: this.directory,
      env: this.env,
      stdio: 'inherit',
    });
    return result.status === 0;
  }

  /** Runs a compose command and returns its output, or null if it failed. */
  read(...args: string[]): string | null {
    const result = spawnSync('docker', ['compose', '-p', PROJECT, ...args], {
      cwd: this.directory,
      env: this.env,
      encoding: 'utf8',
    });
    return result.status === 0 ? result.stdout : null;
  }

  services(): ServiceState[] {
    const output = this.read('ps', '--all', '--format', 'json') ?? '';
    return output
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => serviceStateSchema.parse(JSON.parse(line)));
  }

  service(name: string): ServiceState {
    const state = this.services().find(({ Service }) => Service === name);
    check(state !== undefined, `service ${name} exists`);
    return state;
  }

  url(path: string): string {
    return `${this.appUrl}${path}`;
  }

  config(): z.infer<typeof composeConfigSchema> {
    const output = this.read('config', '--format', 'json');
    check(output !== null, 'docker compose config ran');
    return composeConfigSchema.parse(JSON.parse(output));
  }

  /** Runs with .env changed, then puts it back. */
  withEnvFile<T>(change: (text: string) => string, run: () => T): T {
    const path = join(this.directory, '.env');
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, change(original));
    try {
      return run();
    } finally {
      writeFileSync(path, original);
    }
  }

  async status(path: string, timeoutMs = 5_000): Promise<number | null> {
    try {
      const response = await fetch(this.url(path), {
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.text();
      return response.status;
    } catch {
      return null;
    }
  }

  async snapshots(): Promise<Snapshots> {
    const response = await fetch(
      this.url(`/api/competitors/${COMPETITOR}/snapshots`),
      { signal: AbortSignal.timeout(5_000) },
    );
    check(response.ok, `snapshots answered ${response.status}`);
    return snapshotsSchema.parse(await response.json());
  }
}

async function waitFor(
  description: string,
  seconds: number,
  condition: () => Promise<boolean> | boolean,
): Promise<void> {
  const deadline = Date.now() + seconds * 1_000;
  while (Date.now() < deadline) {
    try {
      if (await condition()) {
        console.log(`ok: ${description}`);
        return;
      }
    } catch {
      // Not ready yet, such as while the app restarts.
    }
    await sleep(1_000);
  }
  throw new Error(`Check failed: ${description} (waited ${seconds}s)`);
}

function psql(stack: Stack, sql: string): string {
  const output = stack.read(
    'exec',
    '-T',
    'db',
    'sh',
    '-c',
    `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "${sql}"`,
  );
  check(output !== null, `psql ran: ${sql}`);
  return output.trim();
}

/** The mock's port isn't published, so this runs inside its container. */
function setMockLatency(stack: Stack, latencyMs: number): void {
  const script = [
    'import urllib.request as u',
    `u.urlopen(u.Request('http://127.0.0.1:4001/control/configure', data=b'{"latencyMs": ${latencyMs}}', headers={'Content-Type': 'application/json'}), timeout=3)`,
  ].join('\n');
  check(
    stack.read('exec', '-T', 'mock-llm', 'python', '-c', script) !== null,
    'the mock accepted its latency',
  );
}

/** A stop must wait for a billed call in progress and save its result. */
async function checkStopDuringLlmCall(stack: Stack): Promise<void> {
  setMockLatency(stack, 8_000);
  const added = await fetch(stack.url('/api/competitors'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: SLOW_COMPETITOR }),
  });
  await added.text();
  check(added.status === 201, `POST answered 201, got ${added.status}`);

  let inFlight = '';
  await waitFor('an LLM call is in progress', 60, () => {
    inFlight = psql(
      stack,
      `SELECT id FROM snapshots WHERE competitor_id = '${SLOW_COMPETITOR}' AND summary_status = 'pending' AND summary_attempts > 0 ORDER BY id LIMIT 1`,
    );
    return inFlight !== '';
  });

  check(stack.run('stop', 'app'), 'the app stops');
  const stopped = stack.service('app');
  check(
    stopped.ExitCode !== SIGKILL_EXIT_CODE,
    'the app finished its call within the grace period',
  );
  const summary = psql(
    stack,
    `SELECT summary_status, summary_attempts FROM snapshots WHERE id = ${inFlight}`,
  );
  check(
    summary === 'done|1',
    `the call in progress was saved before the app stopped, got ${summary}`,
  );
  console.log('ok: a stop finished the LLM call in progress and saved it');

  setMockLatency(stack, 0);
  check(stack.run('start', 'app'), 'the app starts again');
}

/**
 * The process exits while Docker thinks it should be running. A signal from
 * inside only reaches PID 1 through a handler, so this is SIGTERM rather than
 * SIGKILL, and docker kill would count as a manual stop.
 */
async function checkRestartPolicy(stack: Stack): Promise<void> {
  const id = stack.read('ps', '--quiet', 'app')?.trim();
  check(id !== undefined && id !== '', 'the app container exists');
  const restartCount = (): number => {
    const inspected = spawnSync(
      'docker',
      ['inspect', '--format', '{{.RestartCount}}', id],
      { encoding: 'utf8' },
    );
    return Number(inspected.stdout.trim());
  };
  await waitFor('the app is healthy before it exits', 60, () => {
    return stack.service('app').Health === 'healthy';
  });
  const before = restartCount();

  stack.read('exec', '-T', 'app', 'sh', '-c', 'kill -TERM 1');

  await waitFor('the restart policy brings the app back', 90, () => {
    return (
      restartCount() > before && stack.service('app').Health === 'healthy'
    );
  });
}

/** A frozen host keeps its TCP connections open and answers nothing. */
async function checkFrozenPostgres(stack: Stack): Promise<void> {
  check(stack.run('pause', 'db'), 'Postgres freezes');
  await waitFor('/healthz answers 503 in time while Postgres is frozen', 30, async () => {
    return (await stack.status('/healthz', 4_000)) === 503;
  });
  await waitFor('the API answers 503 while Postgres is frozen', 60, async () => {
    return (await stack.status('/api/competitors', 20_000)) === 503;
  });
  check(stack.run('unpause', 'db'), 'Postgres resumes');
  await waitFor('/healthz recovers after the freeze', 60, async () => {
    return (await stack.status('/healthz')) === 200;
  });
  const before = (await stack.snapshots()).length;
  await waitFor('polling recovers after the freeze', 60, async () => {
    return (await stack.snapshots()).length > before;
  });
}

/** Read without starting anything, so a mistake here fails in seconds. */
function checkComposeSettings(stack: Stack): void {
  const [dbPort] = stack.config().services.db.ports;
  check(
    dbPort?.host_ip === '127.0.0.1',
    `Postgres is published only on localhost, got ${dbPort?.host_ip}`,
  );
  check(
    stack.config().services.app.environment.MOCK_API_KEY === 'mock',
    'the example .env enables the mock',
  );
  const withoutMock = stack.withEnvFile(
    (text) => text.replace(/^MOCK_API_KEY=.*$/m, ''),
    () => stack.config().services.app.environment.MOCK_API_KEY,
  );
  check(
    withoutMock === undefined,
    `removing MOCK_API_KEY from .env disables the mock, got ${withoutMock}`,
  );
  console.log('ok: compose settings');
}

function changedCount(snapshots: Snapshots): number {
  return snapshots.filter(({ changed }) => changed).length;
}

async function checkStack(stack: Stack): Promise<void> {
  const declared = (stack.read('config', '--services') ?? '').split('\n');
  for (const service of ['db', 'migrate', 'mock-llm', 'app']) {
    check(declared.includes(service), `compose declares service ${service}`);
  }

  checkComposeSettings(stack);

  check(stack.run('up', '--detach', '--build'), 'docker compose up succeeded');

  await waitFor('the app reports healthy', 120, () => {
    return stack.service('app').Health === 'healthy';
  });
  const migrate = stack.service('migrate');
  check(
    migrate.State === 'exited' && migrate.ExitCode === 0,
    'the one-shot migrate service exited with 0',
  );
  check((await stack.status('/healthz')) === 200, '/healthz answers 200');
  console.log('ok: migrate exited 0 and /healthz answers 200');

  for (const devPackage of ['typescript', 'ts-node', 'jest', 'vite']) {
    const found = stack.read(
      'exec',
      '-T',
      'app',
      'node',
      '-e',
      `require.resolve('${devPackage}/package.json')`,
    );
    check(found === null, `the image has no dev dependency ${devPackage}`);
  }
  console.log('ok: the image has no dev dependencies');

  const page = await fetch(stack.url('/'));
  const html = await page.text();
  check(
    page.status === 200 && html.includes('<div id="root">'),
    'the app serves the built web app',
  );
  console.log('ok: the app serves the web app');

  const added = await fetch(stack.url('/api/competitors'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: COMPETITOR }),
  });
  check(added.status === 201, `POST answered 201, got ${added.status}`);

  await waitFor('every fixture change is summarized by the mock', 90, async () => {
    const snapshots = await stack.snapshots();
    return (
      snapshots.filter(
        ({ summaryStatus, summaryProvider, summary }) =>
          summaryStatus === 'done' &&
          summaryProvider === 'mock' &&
          summary !== null,
      ).length === FIXTURE_CHANGES
    );
  });

  const beforeStop = await stack.snapshots();
  check(
    changedCount(beforeStop) === FIXTURE_CHANGES,
    'the timeline holds exactly the fixture changes',
  );
  const stoppedAt = Date.now();
  check(stack.run('stop', 'app'), 'the app stops');
  const stopSeconds = (Date.now() - stoppedAt) / 1_000;
  const stopped = stack.service('app');
  check(
    stopped.ExitCode !== SIGKILL_EXIT_CODE,
    `the app handles the stop signal, but exited ${stopped.ExitCode} after ${stopSeconds}s`,
  );
  console.log(`ok: the app stopped on the signal in ${stopSeconds}s`);

  check(stack.run('start', 'app'), 'the app starts again');
  await waitFor('polling resumes with no false change', 60, async () => {
    const snapshots = await stack.snapshots();
    return (
      snapshots.length > beforeStop.length + 1 &&
      changedCount(snapshots) === FIXTURE_CHANGES
    );
  });

  await checkStopDuringLlmCall(stack);
  await checkRestartPolicy(stack);

  check(stack.run('stop', 'db'), 'Postgres stops');
  await waitFor('/healthz answers 503 while Postgres is down', 30, async () => {
    return (await stack.status('/healthz')) === 503;
  });
  await waitFor('the API answers 503 while Postgres is down', 30, async () => {
    return (await stack.status('/api/competitors')) === 503;
  });
  check(stack.run('start', 'db'), 'Postgres starts again');
  await waitFor('/healthz recovers', 60, async () => {
    return (await stack.status('/healthz')) === 200;
  });
  const beforeOutageEnd = (await stack.snapshots()).length;
  await waitFor('polling recovers after the outage', 60, async () => {
    return (await stack.snapshots()).length > beforeOutageEnd;
  });

  await checkFrozenPostgres(stack);

  const removed = await fetch(stack.url(`/api/competitors/${COMPETITOR}`), {
    method: 'DELETE',
  });
  await removed.text();
  check(removed.status === 204, `DELETE answered 204, got ${removed.status}`);
  const gone = await stack.status(`/api/competitors/${COMPETITOR}/snapshots`);
  check(gone === 404, `snapshots answered 404 after DELETE, got ${gone}`);
  console.log('ok: removing a competitor removes its timeline');
}

async function main(): Promise<void> {
  const appPort = await freePort();
  const postgresPort = await freePort();
  const directory = copyCleanCheckout();
  const stack = new Stack(directory, `http://127.0.0.1:${appPort}`, {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DOCKER_HOST: process.env.DOCKER_HOST,
    // Real variables win over the copied .env, so this can run beside a dev stack.
    PORT: String(appPort),
    POSTGRES_PORT: String(postgresPort),
    POLL_INTERVAL_SECONDS: '2',
    CHECK_INTERVAL_SECONDS: '1',
  });

  let failure: unknown = null;
  try {
    await checkStack(stack);
  } catch (error) {
    failure = error;
    stack.run('logs', '--tail', '40');
  }
  stack.run('down', '--volumes', '--remove-orphans');
  rmSync(directory, { recursive: true, force: true });

  if (failure !== null) {
    console.error(failure instanceof Error ? failure.message : failure);
    process.exitCode = 1;
    return;
  }
  console.log('Compose check passed');
}

void main();
