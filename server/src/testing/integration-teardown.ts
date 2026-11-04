import './postgres-container';

export default async function teardown(): Promise<void> {
  await globalThis.__postgresContainer?.stop();
}
