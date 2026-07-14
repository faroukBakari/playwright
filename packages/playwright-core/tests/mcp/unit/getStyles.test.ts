import { describe, it, expect } from 'vitest';

import { browserTools } from 'playwright-core/src/tools/tools';

// ---------------------------------------------------------------------------
// P1: browser_get_styles tool registration and schema
//
// The tool handler requires a real tab with refLocator + evaluate, which needs
// a browser. These tests verify registration and schema correctness. Handler
// behavior is validated via the live smoke test.
// ---------------------------------------------------------------------------

describe('browser_get_styles tool registration', () => {
  const tool = browserTools.find(t => t.schema.name === 'browser_get_styles');

  it('is registered in browserTools', () => {
    expect(tool).toBeDefined();
  });

  it('has correct schema name', () => {
    expect(tool!.schema.name).toBe('browser_get_styles');
  });

  it('is a readOnly tool', () => {
    expect(tool!.schema.type).toBe('readOnly');
  });

  it('has core capability', () => {
    expect(tool!.capability).toBe('core');
  });

  it('schema describes ref as required', () => {
    const shape = (tool!.schema.inputSchema as any).shape;
    expect(shape.ref).toBeDefined();
    // ref should not be optional
    expect(shape.ref.isOptional()).toBe(false);
  });

  it('schema describes properties as required array', () => {
    const shape = (tool!.schema.inputSchema as any).shape;
    expect(shape.properties).toBeDefined();
    expect(shape.properties.isOptional()).toBe(false);
  });

  it('schema describes element as optional', () => {
    const shape = (tool!.schema.inputSchema as any).shape;
    expect(shape.element).toBeDefined();
    expect(shape.element.isOptional()).toBe(true);
  });

  it('description mentions computed styles', () => {
    expect(tool!.schema.description).toContain('computed CSS styles');
  });
});
