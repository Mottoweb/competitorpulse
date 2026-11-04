import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { LlmModule } from './llm.module';

describe('LlmModule', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('refuses to start with no provider', async () => {
    process.env = {};

    await expect(
      Test.createTestingModule({ imports: [LlmModule] }).compile(),
    ).rejects.toThrow('No LLM provider');
  });
});
