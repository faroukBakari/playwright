import { describe, it, expect } from 'vitest';

// Import from compiled playwright-core (file: dependency)
import { BrowserServerBackend } from 'playwright-core/src/tools/browserServerBackend';
import { toMcpTool } from 'playwright-core/src/mcp/sdk/tool';
import navigateModule from 'playwright-core/src/tools/navigate';
import formModule from 'playwright-core/src/tools/form';
import keyboardModule from 'playwright-core/src/tools/keyboard';

const navigateTools: any[] = (navigateModule as any).default ?? navigateModule;
const formTools: any[] = (formModule as any).default ?? formModule;
const keyboardTools: any[] = (keyboardModule as any).default ?? keyboardModule;

// ---------------------------------------------------------------------------
// Helper: wrap name+type into a minimal tool-shaped object for _resolveTimeout
// ---------------------------------------------------------------------------
function mockTool(name: string, type: string, minBudget?: (rawArgs: Record<string, unknown>) => number) {
  return { schema: { name, type, minBudget } } as any;
}

// ---------------------------------------------------------------------------
// Universal tool timeout — dispatch-level enforcement
// ---------------------------------------------------------------------------

describe('BrowserServerBackend.NAVIGATE_TOOLS', () => {
  it('contains all navigation tool names', () => {
    const nav = BrowserServerBackend.NAVIGATE_TOOLS;
    expect(nav.has('browser_navigate')).toBe(true);
    expect(nav.has('browser_navigate_and_wait')).toBe(true);
    expect(nav.has('browser_navigate_back')).toBe(true);
    expect(nav.has('browser_navigate_forward')).toBe(true);
    expect(nav.has('browser_reload')).toBe(true);
  });

  it('does not contain non-navigation tools', () => {
    const nav = BrowserServerBackend.NAVIGATE_TOOLS;
    expect(nav.has('browser_snapshot')).toBe(false);
    expect(nav.has('browser_evaluate')).toBe(false);
    expect(nav.has('browser_click')).toBe(false);
  });
});

describe('_resolveTimeout (via prototype)', () => {
  // Access private method via prototype — bind to a mock with _config
  const resolve = BrowserServerBackend.prototype['_resolveTimeout'];
  const noConfig = {
    _config: {
      timeouts: {
        budget: { default: 5000, navigate: 15000, runCode: 30000 },
      },
    },
  };
  const withConfig = {
    _config: {
      timeouts: {
        budget: { default: 8000, navigate: 20000, runCode: 45000 },
      },
    },
  };

  it('returns explicit override in ms', () => {
    expect(resolve.call(noConfig, mockTool('browser_evaluate', 'action'), {}, 5)).toBe(5000);
    expect(resolve.call(noConfig, mockTool('browser_snapshot', 'readOnly'), {}, 10)).toBe(10000);
  });

  it('returns 15000 for navigate tools without override', () => {
    expect(resolve.call(noConfig, mockTool('browser_navigate', 'action'), undefined, undefined)).toBe(15000);
    expect(resolve.call(noConfig, mockTool('browser_navigate_and_wait', 'action'), undefined, undefined)).toBe(15000);
    expect(resolve.call(noConfig, mockTool('browser_navigate_back', 'action'), undefined, undefined)).toBe(15000);
  });

  it('returns 30000 for browser_run_code without override', () => {
    expect(resolve.call(noConfig, mockTool('browser_run_code', 'action'), undefined, undefined)).toBe(30000);
  });

  it('returns type-based default for regular tools', () => {
    expect(resolve.call(noConfig, mockTool('browser_evaluate', 'action'), undefined, undefined)).toBe(5000);
    expect(resolve.call(noConfig, mockTool('browser_snapshot', 'readOnly'), undefined, undefined)).toBe(5000);
    expect(resolve.call(noConfig, mockTool('browser_click', 'input'), undefined, undefined)).toBe(5000);
    expect(resolve.call(noConfig, mockTool('browser_wait_for', 'assertion'), undefined, undefined)).toBe(5000);
  });

  it('returns 5000 for unknown tool type', () => {
    expect(resolve.call(noConfig, mockTool('unknown_tool', 'unknownType'), undefined, undefined)).toBe(5000);
  });

  it('explicit override takes precedence over navigate default', () => {
    expect(resolve.call(noConfig, mockTool('browser_navigate', 'action'), {}, 30)).toBe(30000);
  });

  it('explicit override takes precedence over run_code default', () => {
    expect(resolve.call(noConfig, mockTool('browser_run_code', 'action'), {}, 2)).toBe(2000);
  });

  it('explicit override takes precedence over config', () => {
    expect(resolve.call(withConfig, mockTool('browser_navigate', 'action'), {}, 5)).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// minBudget — tool-supplied timeout floor
// ---------------------------------------------------------------------------

describe('_resolveTimeout with minBudget', () => {
  const resolve = BrowserServerBackend.prototype['_resolveTimeout'];
  const ctx = {
    _config: {
      timeouts: {
        budget: { default: 5000, navigate: 15000, runCode: 30000 },
      },
    },
  };

  it('minBudget raises effective default above tier budget', () => {
    const tool = mockTool('browser_fill_form', 'input', () => 10000);
    expect(resolve.call(ctx, tool, {}, undefined)).toBe(10000);
  });

  it('minBudget below tier budget has no effect', () => {
    const tool = mockTool('browser_fill_form', 'input', () => 3000);
    expect(resolve.call(ctx, tool, {}, undefined)).toBe(5000);
  });

  it('minBudget of 0 falls back to tier budget', () => {
    const tool = mockTool('browser_type', 'input', () => 0);
    expect(resolve.call(ctx, tool, {}, undefined)).toBe(5000);
  });

  it('no minBudget falls back to tier budget', () => {
    const tool = mockTool('browser_click', 'input');
    expect(resolve.call(ctx, tool, {}, undefined)).toBe(5000);
  });

  it('user timeout above minBudget takes effect', () => {
    const tool = mockTool('browser_fill_form', 'input', () => 10000);
    expect(resolve.call(ctx, tool, {}, 20)).toBe(20000);
  });

  it('user timeout below minBudget is floored', () => {
    const tool = mockTool('browser_fill_form', 'input', () => 10000);
    expect(resolve.call(ctx, tool, {}, 2)).toBe(10000);
  });

  it('minBudget receives rawArguments', () => {
    const tool = mockTool('browser_fill_form', 'input', rawArgs => {
      const n = Array.isArray(rawArgs.fields) ? rawArgs.fields.length : 1;
      return n * 2000;
    });
    const args = { fields: [{ ref: 'a' }, { ref: 'b' }, { ref: 'c' }] };
    expect(resolve.call(ctx, tool, args, undefined)).toBe(6000);
  });

  it('minBudget with undefined rawArguments uses empty object', () => {
    const tool = mockTool('browser_fill_form', 'input', rawArgs => {
      return Array.isArray(rawArgs.fields) ? rawArgs.fields.length * 2000 : 5000;
    });
    expect(resolve.call(ctx, tool, undefined, undefined)).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// fill_form minBudget formula spot-checks
// ---------------------------------------------------------------------------

describe('browser_fill_form minBudget formula', () => {
  const fillForm = formTools.find((t: any) => t.schema.name === 'browser_fill_form');
  const fillFormMinBudget = fillForm?.schema?.minBudget as (rawArgs: Record<string, unknown>) => number;

  it('fill_form tool exists and has minBudget', () => {
    expect(fillForm).toBeDefined();
    expect(fillFormMinBudget).toBeTypeOf('function');
  });

  it('1 field no submit → 5000ms floor', () => {
    expect(fillFormMinBudget({ fields: [{}] })).toBe(5000);
  });

  it('3 fields no submit → 5000ms floor', () => {
    expect(fillFormMinBudget({ fields: [{}, {}, {}] })).toBe(5000);
  });

  it('3 fields + submitRef → scales above default', () => {
    const result = fillFormMinBudget({ fields: [{}, {}, {}], submitRef: 'btn' });
    expect(result).toBeGreaterThan(5000);
    expect(result).toBeLessThan(20000);
  });

  it('7 fields + submitRef → scales higher', () => {
    const with3 = fillFormMinBudget({ fields: [{}, {}, {}], submitRef: 'btn' });
    const with7 = fillFormMinBudget({ fields: [{}, {}, {}, {}, {}, {}, {}], submitRef: 'btn' });
    expect(with7).toBeGreaterThan(with3);
  });

  it('missing fields defaults to 1 field', () => {
    const result = fillFormMinBudget({});
    expect(result).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// browser_type minBudget formula spot-checks
// ---------------------------------------------------------------------------

describe('browser_type minBudget formula', () => {
  const typeTool = keyboardTools.find((t: any) => t.schema.name === 'browser_type');
  const typeMinBudget = typeTool?.schema?.minBudget as (rawArgs: Record<string, unknown>) => number;

  it('browser_type tool exists and has minBudget', () => {
    expect(typeTool).toBeDefined();
    expect(typeMinBudget).toBeTypeOf('function');
  });

  it('fast path (no slowly) → 0', () => {
    expect(typeMinBudget({ text: 'hello' })).toBe(0);
  });

  it('slowly with short text → 5000ms floor', () => {
    expect(typeMinBudget({ text: 'hi', slowly: true })).toBe(5000);
  });

  it('slowly with 200 chars → scales above default', () => {
    const text = 'a'.repeat(200);
    const result = typeMinBudget({ text, slowly: true });
    expect(result).toBeGreaterThan(10000);
  });

  it('slowly scales linearly with text length', () => {
    const short = typeMinBudget({ text: 'a'.repeat(50), slowly: true });
    const long = typeMinBudget({ text: 'a'.repeat(200), slowly: true });
    expect(long).toBeGreaterThan(short);
  });
});

// ---------------------------------------------------------------------------
// toMcpTool schema injection
// ---------------------------------------------------------------------------

describe('toMcpTool schema injection', () => {
  it('injects timeout into tool inputSchema properties', () => {
    // Use a real tool schema for realistic testing
    const navTool = navigateTools.find((t: any) => t.schema.name === 'browser_navigate');
    const mcpTool = toMcpTool(navTool.schema);
    const props = (mcpTool.inputSchema as any).properties;

    expect(props.timeout).toBeDefined();
    expect(props.timeout.type).toBe('number');
    expect(props.timeout.description).toContain('Timeout in seconds');
  });

  it('preserves existing schema properties', () => {
    const navTool = navigateTools.find((t: any) => t.schema.name === 'browser_navigate');
    const mcpTool = toMcpTool(navTool.schema);
    const props = (mcpTool.inputSchema as any).properties;

    expect(props.url).toBeDefined();
  });
});
