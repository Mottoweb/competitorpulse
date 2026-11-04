import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { OPENAPI_SPEC_PATH } from '../openapi/openapi';

const operationSchema = z.looseObject({
  parameters: z.array(z.looseObject({ name: z.string() })).optional(),
  requestBody: z.unknown().optional(),
  responses: z.record(
    z.string(),
    z.looseObject({
      content: z
        .record(z.string(), z.looseObject({ schema: z.unknown() }))
        .optional(),
    }),
  ),
});

const specSchema = z.looseObject({
  paths: z.record(z.string(), z.record(z.string(), operationSchema)),
  components: z
    .looseObject({
      schemas: z
        .record(
          z.string(),
          z.looseObject({
            properties: z.record(z.string(), z.unknown()).optional(),
            required: z.array(z.string()).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

export type OpenApiSpec = z.infer<typeof specSchema>;

export function readCommittedSpec(): OpenApiSpec {
  return specSchema.parse(
    JSON.parse(readFileSync(OPENAPI_SPEC_PATH, 'utf8')) as unknown,
  );
}

/** Makes every object schema reject undeclared fields, so a leak fails the check. */
function closeObjects(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(closeObjects);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const closed = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, closeObjects(child)]),
  );
  return 'properties' in closed
    ? { ...closed, additionalProperties: false }
    : closed;
}

export interface ObservedResponse {
  status: number;
  type: string;
  text: string;
  body: unknown;
}

/** What is wrong with a real response, judged by the committed spec. Empty is a match. */
export function specViolations(
  method: 'get' | 'post' | 'delete',
  path: string,
  response: ObservedResponse,
): string[] {
  const spec = readCommittedSpec();
  const label = `${method.toUpperCase()} ${path} ${response.status}`;
  const declared = spec.paths[path]?.[method]?.responses[String(response.status)];
  if (declared === undefined) {
    return [`${label} is not declared in the spec`];
  }

  if (declared.content === undefined) {
    return response.text === '' ? [] : [`${label} declares no body but sent one`];
  }
  const media = declared.content[response.type];
  if (media === undefined) {
    return [`${label} declares no ${response.type} body`];
  }

  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile({
    allOf: [closeObjects(media.schema)],
    components: closeObjects(spec.components ?? {}),
  });
  if (validate(response.body)) {
    return [];
  }
  return (validate.errors ?? []).map(
    (error) => `${label}: ${error.instancePath} ${error.message ?? ''}`,
  );
}
