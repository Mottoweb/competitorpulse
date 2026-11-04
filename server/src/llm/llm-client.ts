import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { z } from 'zod';
import { EmptyResponseError } from './failure';
import type { LlmConfig, LlmProvider } from './llm-config';

export interface LlmPrompt {
  system: string;
  user: string;
}

export interface LlmClient {
  complete(provider: LlmProvider, prompt: LlmPrompt): Promise<string>;
}

export const LLM_CLIENT = Symbol('LLM_CLIENT');

const chatResponseSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable() }) }))
    .min(1),
});

const messageResponseSchema = z.object({
  content: z.array(
    z.object({ type: z.string(), text: z.string().optional() }),
  ),
});

function chatText(response: unknown): string {
  const parsed = chatResponseSchema.safeParse(response);
  return parsed.success ? (parsed.data.choices[0]?.message.content ?? '') : '';
}

/** A refusal has no text blocks, so it fails over like an empty reply. */
function messageText(response: unknown): string {
  const parsed = messageResponseSchema.safeParse(response);
  return parsed.success
    ? parsed.data.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
    : '';
}

/**
 * One request per attempt. SDK retries are off because the worker owns retries:
 * they would multiply the billed calls and hide failures from the attempt cap.
 */
export class SdkLlmClient implements LlmClient {
  private readonly openAiClients = new Map<string, OpenAI>();
  private readonly anthropicClients = new Map<string, Anthropic>();

  constructor(private readonly config: LlmConfig) {}

  async complete(provider: LlmProvider, prompt: LlmPrompt): Promise<string> {
    const text = (await this.request(provider, prompt)).trim();
    if (text === '') {
      throw new EmptyResponseError(provider.name);
    }
    return text;
  }

  private request(provider: LlmProvider, prompt: LlmPrompt): Promise<string> {
    switch (provider.api) {
      case 'openai_compatible':
        return this.requestChat(provider, prompt);
      case 'anthropic':
        return this.requestMessage(provider, prompt);
    }
  }

  // The signal also covers reading the body, which the SDK's timeout doesn't.
  private requestOptions(): { timeout: number; signal: AbortSignal } {
    return {
      timeout: this.config.timeoutMs,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    };
  }

  private async requestChat(
    provider: LlmProvider,
    prompt: LlmPrompt,
  ): Promise<string> {
    const response = await this.openAiClient(provider).chat.completions.create(
      {
        model: provider.model,
        [provider.tokenLimitParam]: this.config.maxTokens,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
      },
      this.requestOptions(),
    );
    return chatText(response);
  }

  private async requestMessage(
    provider: LlmProvider,
    prompt: LlmPrompt,
  ): Promise<string> {
    const response = await this.anthropicClient(provider).messages.create(
      {
        model: provider.model,
        max_tokens: this.config.maxTokens,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
      },
      this.requestOptions(),
    );
    return messageText(response);
  }

  private openAiClient(provider: LlmProvider): OpenAI {
    const existing = this.openAiClients.get(provider.name);
    if (existing !== undefined) {
      return existing;
    }
    const client = new OpenAI({
      apiKey: provider.apiKey,
      baseURL: provider.baseUrl,
      maxRetries: 0,
    });
    this.openAiClients.set(provider.name, client);
    return client;
  }

  private anthropicClient(provider: LlmProvider): Anthropic {
    const existing = this.anthropicClients.get(provider.name);
    if (existing !== undefined) {
      return existing;
    }
    const client = new Anthropic({
      apiKey: provider.apiKey,
      baseURL: provider.baseUrl,
      maxRetries: 0,
    });
    this.anthropicClients.set(provider.name, client);
    return client;
  }
}
