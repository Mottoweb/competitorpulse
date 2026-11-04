import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

const statsSchema = z.object({ callCount: z.number() });
const SCRIPT = join(__dirname, '../../../files/mock-llm/mock-llm-server.py');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') {
          reject(new Error('No port was assigned'));
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

/** The provided mock server on its own port, so spec files can't disturb each other. */
export class MockLlm {
  private constructor(
    private readonly origin: string,
    private readonly process: ChildProcess,
  ) {}

  static async start(): Promise<MockLlm> {
    const port = await freePort();
    const child = spawn('python3', [SCRIPT], {
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    });
    const mock = new MockLlm(`http://127.0.0.1:${port}`, child);
    await mock.waitUntilHealthy();
    return mock;
  }

  get baseUrl(): string {
    return `${this.origin}/v1`;
  }

  async callCount(): Promise<number> {
    const response = await fetch(`${this.origin}/control/stats`);
    return statsSchema.parse(await response.json()).callCount;
  }

  async configure(settings: {
    latencyMs?: number;
    failNext?: number;
  }): Promise<void> {
    await fetch(`${this.origin}/control/configure`, {
      method: 'POST',
      body: JSON.stringify(settings),
    });
  }

  async reset(): Promise<void> {
    await fetch(`${this.origin}/control/reset`, { method: 'POST' });
  }

  stop(): void {
    this.process.kill();
  }

  private async waitUntilHealthy(): Promise<void> {
    // Sequential on purpose: each try waits for the server to come up.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(`${this.origin}/health`);
        if (response.ok) {
          return;
        }
      } catch {
        // Not listening yet.
      }
      await sleep(50);
    }
    this.stop();
    throw new Error('The mock LLM server did not start');
  }
}
