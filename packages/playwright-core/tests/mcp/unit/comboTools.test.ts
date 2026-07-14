import { describe, it, expect, vi } from 'vitest';

// Import tool arrays from compiled playwright-core
// Default exports compile to .default in CJS
import formModule from 'playwright-core/src/tools/form';
import navigateModule from 'playwright-core/src/tools/navigate';
import { resolveTimeout } from 'playwright-core/src/tools/wait';
import { Response } from 'playwright-core/src/tools/response';

const formTools: any[] = (formModule as any).default ?? formModule;
const navigateTools: any[] = (navigateModule as any).default ?? navigateModule;

// ---------------------------------------------------------------------------
// Wave 5: Combo tools — schema verification + export validation
// ---------------------------------------------------------------------------

describe('browser_fill_form schema (Patch 1+2)', () => {
  const fillForm = formTools.find((t: any) => t.schema.name === 'browser_fill_form');

  it('exists in form tool exports', () => {
    expect(fillForm).toBeDefined();
  });

  it('has submitRef optional param in schema', () => {
    const shape = fillForm!.schema.inputSchema.shape;
    expect(shape.submitRef).toBeDefined();
    expect(shape.submitRef.isOptional()).toBe(true);
  });

  it('has submitElement optional param in schema', () => {
    const shape = fillForm!.schema.inputSchema.shape;
    expect(shape.submitElement).toBeDefined();
    expect(shape.submitElement.isOptional()).toBe(true);
  });

  it('retains existing fields array param', () => {
    const shape = fillForm!.schema.inputSchema.shape;
    expect(shape.fields).toBeDefined();
  });

  it('description mentions submit', () => {
    expect(fillForm!.schema.description).toContain('submit');
  });
});

describe('browser_navigate_and_wait schema (Patch 3)', () => {
  const navAndWait = navigateTools.find((t: any) => t.schema.name === 'browser_navigate_and_wait');

  it('exists in navigate tool exports', () => {
    expect(navAndWait).toBeDefined();
  });

  it('has url required param', () => {
    const shape = navAndWait!.schema.inputSchema.shape;
    expect(shape.url).toBeDefined();
    expect(shape.url.isOptional()).toBe(false);
  });

  it('has waitForText optional param', () => {
    const shape = navAndWait!.schema.inputSchema.shape;
    expect(shape.waitForText).toBeDefined();
    expect(shape.waitForText.isOptional()).toBe(true);
  });

  it('has waitForSelector optional param', () => {
    const shape = navAndWait!.schema.inputSchema.shape;
    expect(shape.waitForSelector).toBeDefined();
    expect(shape.waitForSelector.isOptional()).toBe(true);
  });

  it('has waitForUrl optional param', () => {
    const shape = navAndWait!.schema.inputSchema.shape;
    expect(shape.waitForUrl).toBeDefined();
    expect(shape.waitForUrl.isOptional()).toBe(true);
  });

  it('has timeout optional param', () => {
    const shape = navAndWait!.schema.inputSchema.shape;
    expect(shape.timeout).toBeDefined();
    expect(shape.timeout.isOptional()).toBe(true);
  });

  it('has capability core-navigation', () => {
    expect(navAndWait!.capability).toBe('core-navigation');
  });

  it('has type action', () => {
    expect(navAndWait!.schema.type).toBe('action');
  });

  it('does not duplicate browser_navigate', () => {
    const navigateTools_ = navigateTools.filter((t: any) => t.schema.name === 'browser_navigate');
    expect(navigateTools_).toHaveLength(1);
  });
});

describe('browser_fill_form snapshot behavior', () => {
  const fillForm = formTools.find((t: any) => t.schema.name === 'browser_fill_form');

  function createStubs() {
    const locator = {
      fill: vi.fn().mockResolvedValue(undefined),
      setChecked: vi.fn().mockResolvedValue(undefined),
      selectOption: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
    };
    const tab = {
      waitForCompletion: vi.fn().mockImplementation(async (fn: any) => fn()),
      refLocator: vi.fn().mockResolvedValue({ locator, resolved: `getByRole('textbox', { name: 'Name' })` }),
      context: { lookupSecret: (v: string) => ({ value: v, code: `'${v}'` }) },
      actionTimeoutOptions: {},
      modalStates: () => [],
    };
    const context = {
      id: 'test-context-id',
      ensureTab: vi.fn().mockResolvedValue(tab),
      config: { snapshot: { mode: 'incremental' } },
      options: { cwd: '/tmp' },
      currentTab: () => undefined,
      tabs: () => [],
    };
    const response = new Response(context as any, 'browser_fill_form', {});
    return { context, tab, locator, response };
  }

  it('calls setIncludeSnapshot after filling fields', async () => {
    const { context, response } = createStubs();
    await fillForm!.handle(context, {
      fields: [{ name: 'Name', type: 'textbox', ref: 'e4', value: 'John' }],
    }, response);
    expect((response as any)._includeSnapshot).toBe('diff');
  });

  it('calls setIncludeSnapshot after filling + submit', async () => {
    const { context, response } = createStubs();
    await fillForm!.handle(context, {
      fields: [{ name: 'Name', type: 'textbox', ref: 'e4', value: 'John' }],
      submitRef: 'e10',
    }, response);
    expect((response as any)._includeSnapshot).toBe('diff');
  });

  it('radio field uses click(), not setChecked()', async () => {
    const { context, locator, response } = createStubs();
    await fillForm!.handle(context, {
      fields: [{ name: "Bachelor's Degree", type: 'radio', ref: 'e2102', value: 'Yes' }],
    }, response);
    expect(locator.click).toHaveBeenCalledOnce();
    expect(locator.setChecked).not.toHaveBeenCalled();
  });

  it('checkbox field uses setChecked(), not click()', async () => {
    const { context, locator, response } = createStubs();
    await fillForm!.handle(context, {
      fields: [{ name: 'Agree to terms', type: 'checkbox', ref: 'e42', value: 'true' }],
    }, response);
    expect(locator.setChecked).toHaveBeenCalledWith(true, expect.any(Object));
    expect(locator.click).not.toHaveBeenCalled();
  });
});

describe('wait.ts exports (Patch 3 prerequisite)', () => {
  it('resolveTimeout is exported and callable', () => {
    expect(typeof resolveTimeout).toBe('function');
  });

  it('resolveTimeout uses hardcoded default (3000ms) when no timeout param', () => {
    const stubTab = { context: { config: {} } } as any;
    expect(resolveTimeout(stubTab, {})).toBe(3000);
  });

  it('resolveTimeout caps at hardcoded maxTimeout (30000ms)', () => {
    const stubTab = { context: { config: {} } } as any;
    // timeout param is in seconds, resolveTimeout converts to ms
    // 50s = 50000ms, capped to hardcoded max 30000ms
    expect(resolveTimeout(stubTab, { timeout: 50 })).toBe(30000);
  });

  it('resolveTimeout converts seconds to ms', () => {
    const stubTab = { context: { config: {} } } as any;
    expect(resolveTimeout(stubTab, { timeout: 5 })).toBe(5000);
  });
});
