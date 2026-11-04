import { Logger, Module } from '@nestjs/common';
import { LLM_CLIENT, SdkLlmClient } from './llm-client';
import { LLM_CONFIG, parseLlmConfig, type LlmConfig } from './llm-config';
import { ProviderFailover } from './provider-failover';

@Module({
  providers: [
    {
      provide: LLM_CONFIG,
      useFactory: (): LlmConfig => {
        const config = parseLlmConfig(process.env);
        const order = config.providers.map((provider) => provider.name);
        new Logger('LlmModule').log(`LLM provider order: ${order.join(', ')}`);
        return config;
      },
    },
    {
      provide: ProviderFailover,
      useFactory: (config: LlmConfig) => new ProviderFailover(config),
      inject: [LLM_CONFIG],
    },
    {
      provide: LLM_CLIENT,
      useFactory: (config: LlmConfig) => new SdkLlmClient(config),
      inject: [LLM_CONFIG],
    },
  ],
  exports: [LLM_CONFIG, ProviderFailover, LLM_CLIENT],
})
export class LlmModule {}
