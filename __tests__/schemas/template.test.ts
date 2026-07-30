import { describe, expect, it } from 'vitest';

import {
  LocatorSchema,
  OccurrenceSchema,
  TemplateSchema,
  TemplatesFileSchema,
} from '../../src/schemas/template.js';

const validLocator = [3, 1024, 256];

const validTemplate = {
  templateId: 'abc123',
  toolType: 'Bash',
  maskedSignature: 'error TS<NUM>: Cannot find module <PATH>',
  createdAt: '2026-07-30T00:00:00.000Z',
  occurrenceCount: 1,
  exemplarLocator: validLocator,
};

const validOccurrence = {
  templateId: 'abc123',
  locator: validLocator,
  sessionId: 'session-1',
  timestamp: '2026-07-30T00:00:00.000Z',
};

describe('LocatorSchema', () => {
  it('accepts a [transcriptIndex, byteOffset, byteLength] tuple', () => {
    expect(LocatorSchema.parse(validLocator)).toEqual(validLocator);
  });

  it('rejects a negative transcript index', () => {
    expect(LocatorSchema.safeParse([-1, 0, 1]).success).toBe(false);
  });

  it('rejects a zero or negative byte length', () => {
    expect(LocatorSchema.safeParse([0, 0, 0]).success).toBe(false);
  });

  it('rejects a tuple of the wrong length', () => {
    expect(LocatorSchema.safeParse([0, 0]).success).toBe(false);
  });
});

describe('TemplateSchema', () => {
  it('accepts a valid template', () => {
    expect(TemplateSchema.parse(validTemplate)).toEqual(validTemplate);
  });

  it('rejects a malformed locator', () => {
    const result = TemplateSchema.safeParse({ ...validTemplate, exemplarLocator: [0, 0] });
    expect(result.success).toBe(false);
  });

  it('rejects a missing templateId', () => {
    const { templateId: _templateId, ...rest } = validTemplate;
    expect(TemplateSchema.safeParse(rest).success).toBe(false);
  });
});

describe('OccurrenceSchema', () => {
  it('accepts a valid occurrence without extractedParams', () => {
    expect(OccurrenceSchema.parse(validOccurrence)).toEqual(validOccurrence);
  });

  it('accepts extractedParams as a string map', () => {
    const withParams = { ...validOccurrence, extractedParams: { filePath: 'src/x.ts' } };
    expect(OccurrenceSchema.parse(withParams)).toEqual(withParams);
  });

  it('rejects a malformed locator', () => {
    const result = OccurrenceSchema.safeParse({ ...validOccurrence, locator: [0, 0] });
    expect(result.success).toBe(false);
  });
});

describe('TemplatesFileSchema', () => {
  it('defaults templates to an empty array', () => {
    expect(TemplatesFileSchema.parse({})).toEqual({ templates: [] });
  });

  it('accepts a populated templates array', () => {
    const file = { templates: [validTemplate] };
    expect(TemplatesFileSchema.parse(file)).toEqual(file);
  });
});
