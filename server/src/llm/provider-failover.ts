import type { FailureKind } from './failure';
import type { LlmConfig, LlmProvider } from './llm-config';
import type { ProviderName } from './providers';

/**
 * Picks the provider for an attempt. The attempt number lives in Postgres, so
 * failover survives a crash. Cooldowns are per instance and lost on restart,
 * which only costs one more failed call.
 */
export class ProviderFailover {
  private readonly cooldownUntil = new Map<ProviderName, number>();

  constructor(
    private readonly config: LlmConfig,
    private readonly now: () => number = Date.now,
  ) {}

  select(attempt: number): LlmProvider {
    const { providers } = this.config;
    const start = (attempt - 1) % providers.length;
    const candidates = [...providers.slice(start), ...providers.slice(0, start)];
    const time = this.now();
    const provider =
      candidates.find(
        ({ name }) => (this.cooldownUntil.get(name) ?? 0) <= time,
      ) ?? candidates[0];
    if (provider === undefined) {
      throw new Error('No LLM provider is configured');
    }
    return provider;
  }

  recordFailure(provider: LlmProvider, kind: FailureKind): void {
    const cooldownMs = this.cooldownFor(kind);
    if (cooldownMs > 0) {
      this.cooldownUntil.set(provider.name, this.now() + cooldownMs);
    }
  }

  private cooldownFor(kind: FailureKind): number {
    switch (kind) {
      case 'transient':
        return this.config.failureCooldownMs;
      case 'provider_unusable':
        return this.config.unusableCooldownMs;
      case 'bad_request':
        return 0;
    }
  }
}
