import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EmptyResponseError } from './failure';
import { SdkLlmClient } from './llm-client';
import { parseLlmConfig, type LlmConfig, type LlmProvider } from './llm-config';

const PROMPT = { system: 'be brief', user: 'what changed?' };

interface Seen {
  path: string;
  auth: string | undefined;
  body: unknown;
}

describe('SdkLlmClient', () => {
  let server: Server;
  let origin: string;
  let seen: Seen[];
  let reply: { status: number; body: unknown; delayMs?: number };

  const clientFor = (
    name: 'DEEPSEEK' | 'OPENAI' | 'ANTHROPIC',
    baseUrl: string,
    overrides: Partial<LlmConfig> = {},
  ): { client: SdkLlmClient; provider: LlmProvider } => {
    const config = {
      ...parseLlmConfig({
        [`${name}_API_KEY`]: 'test-key',
        [`${name}_BASE_URL`]: baseUrl,
      }),
      ...overrides,
    };
    const provider = config.providers[0];
    if (provider === undefined) {
      throw new Error('No provider');
    }
    return { client: new SdkLlmClient(config), provider };
  };

  const chatReply = (content: string | null): unknown => ({
    id: 'x',
    object: 'chat.completion',
    created: 1,
    model: 'm',
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
    ],
  });

  const anthropicReply = (content: unknown[]): unknown => ({
    id: 'x',
    type: 'message',
    role: 'assistant',
    model: 'm',
    content,
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        seen.push({
          path: request.url ?? '',
          auth: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString()),
        });
        setTimeout(() => {
          response.writeHead(reply.status, {
            'content-type': 'application/json',
          });
          response.end(JSON.stringify(reply.body));
        }, reply.delayMs ?? 0);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    seen = [];
    reply = { status: 200, body: chatReply(' A summary. ') };
  });

  describe('OpenAI-compatible providers', () => {
    it('sends the prompt with max_tokens and returns the trimmed text', async () => {
      const { client, provider } = clientFor('DEEPSEEK', `${origin}/v1`);

      await expect(client.complete(provider, PROMPT)).resolves.toBe('A summary.');

      expect(seen[0]?.path).toBe('/v1/chat/completions');
      expect(seen[0]?.auth).toBe('Bearer test-key');
      expect(seen[0]?.body).toMatchObject({
        model: 'deepseek-chat',
        max_tokens: 1000,
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'what changed?' },
        ],
      });
    });

    it('sends max_completion_tokens to OpenAI, which rejects max_tokens', async () => {
      const { client, provider } = clientFor('OPENAI', `${origin}/v1`);

      await client.complete(provider, PROMPT);

      expect(seen[0]?.body).toMatchObject({ max_completion_tokens: 1000 });
      expect(seen[0]?.body).not.toHaveProperty('max_tokens');
    });

    it('rejects an empty response', async () => {
      const { client, provider } = clientFor('DEEPSEEK', `${origin}/v1`);
      reply = { status: 200, body: chatReply('   ') };

      await expect(client.complete(provider, PROMPT)).rejects.toBeInstanceOf(
        EmptyResponseError,
      );
    });

    it('rejects a response of the wrong shape', async () => {
      const { client, provider } = clientFor('DEEPSEEK', `${origin}/v1`);
      reply = { status: 200, body: { choices: [] } };

      await expect(client.complete(provider, PROMPT)).rejects.toBeInstanceOf(
        EmptyResponseError,
      );
    });

    it('makes one request on a 500, leaving retries to the worker', async () => {
      const { client, provider } = clientFor('DEEPSEEK', `${origin}/v1`);
      reply = { status: 500, body: { error: { message: 'down' } } };

      await expect(client.complete(provider, PROMPT)).rejects.toMatchObject({
        status: 500,
      });
      expect(seen).toHaveLength(1);
    });

    it('aborts a call that outlasts the timeout, once', async () => {
      const { client, provider } = clientFor('DEEPSEEK', `${origin}/v1`, {
        timeoutMs: 50,
      });
      reply = { status: 200, body: chatReply('late'), delayMs: 500 };

      await expect(client.complete(provider, PROMPT)).rejects.toBeInstanceOf(
        Error,
      );
      expect(seen).toHaveLength(1);
    });
  });

  describe('Anthropic', () => {
    it('sends the prompt through the Messages API and joins the text blocks', async () => {
      const { client, provider } = clientFor('ANTHROPIC', origin);
      reply = {
        status: 200,
        body: anthropicReply([
          { type: 'thinking', thinking: '', signature: 's' },
          { type: 'text', text: ' A summary. ' },
        ]),
      };

      await expect(client.complete(provider, PROMPT)).resolves.toBe('A summary.');

      expect(seen[0]?.path).toBe('/v1/messages');
      expect(seen[0]?.auth).toBe('Bearer test-key');
      expect(seen[0]?.body).toMatchObject({
        model: 'claude-opus-5-5',
        max_tokens: 1000,
        system: 'be brief',
        messages: [{ role: 'user', content: 'what changed?' }],
      });
    });

    it('rejects a reply with no text, such as a refusal', async () => {
      const { client, provider } = clientFor('ANTHROPIC', origin);
      reply = { status: 200, body: anthropicReply([]) };

      await expect(client.complete(provider, PROMPT)).rejects.toBeInstanceOf(
        EmptyResponseError,
      );
    });

    it('makes one request on a 429, leaving retries to the worker', async () => {
      const { client, provider } = clientFor('ANTHROPIC', origin);
      reply = {
        status: 429,
        body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow' } },
      };

      await expect(client.complete(provider, PROMPT)).rejects.toMatchObject({
        status: 429,
      });
      expect(seen).toHaveLength(1);
    });
  });
});
