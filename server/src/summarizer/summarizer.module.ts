import { Module } from '@nestjs/common';
import { LLM_CONFIG, type LlmConfig } from '../llm/llm-config';
import { LlmModule } from '../llm/llm.module';
import { SUMMARIZER_CONFIG, parseSummarizerConfig } from './summarizer-config';
import { SummaryQueries } from './summary-queries';
import { SummaryWorker } from './summary-worker';

@Module({
  imports: [LlmModule],
  providers: [
    SummaryQueries,
    SummaryWorker,
    {
      provide: SUMMARIZER_CONFIG,
      useFactory: (llm: LlmConfig) =>
        parseSummarizerConfig(process.env, llm.maxAttempts),
      inject: [LLM_CONFIG],
    },
  ],
  exports: [SummaryQueries],
})
export class SummarizerModule {}
