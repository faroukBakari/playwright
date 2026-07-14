import { describe, it, expect } from 'vitest';

import { defaultConfig, mergeConfig, validateConfig } from 'playwright-core/src/mcp/config';
import type { FullConfig } from 'playwright-core/src/mcp/config';

const validRelay = { maxConcurrentClients: 4, sessionGraceTTL: 5000, backendDisposalTTL: 10000 };

/** Build a FullConfig with surgical overrides for validation testing.
 *  Includes valid relay by default so relay checks don't mask other violations. */
function buildConfig(overrides: Parameters<typeof mergeConfig>[1]): FullConfig {
  return mergeConfig(defaultConfig, { relay: validRelay, ...overrides });
}

describe('validateConfig', () => {
  describe('timeout cascade', () => {
    it('rejects budget.default <= 0', async () => {
      const config = buildConfig({ timeouts: { budget: { default: 0 } } });
      await expect(validateConfig(config)).rejects.toThrow('budget.default must be positive');
    });

    it('rejects budget.navigate < budget.default', async () => {
      const config = buildConfig({ timeouts: { budget: { default: 5000, navigate: 3000 } } });
      await expect(validateConfig(config)).rejects.toThrow('budget.navigate (3000ms) < budget.default (5000ms)');
    });

    it('rejects budget.runCode < budget.default', async () => {
      const config = buildConfig({ timeouts: { budget: { default: 5000, runCode: 2000 } } });
      await expect(validateConfig(config)).rejects.toThrow('budget.runCode (2000ms) < budget.default (5000ms)');
    });

    it('accepts valid config (no throw)', async () => {
      const config = buildConfig({});
      await expect(validateConfig(config)).resolves.toBeUndefined();
    });

    it('accepts config with no playwright section', async () => {
      const config = buildConfig({ timeouts: { budget: { default: 5000, navigate: 15000, runCode: 30000 } } });
      // Explicitly remove the playwright section to simulate simplified config
      delete (config.timeouts as any).playwright;
      await expect(validateConfig(config)).resolves.toBeUndefined();
    });
  });

  describe('relay required fields', () => {
    /** Build config WITHOUT the default validRelay so we can test missing fields. */
    function buildRelayConfig(relay: any): FullConfig {
      return mergeConfig(defaultConfig, { relay });
    }

    it('rejects missing maxConcurrentClients', async () => {
      const config = buildRelayConfig({ sessionGraceTTL: 5000, backendDisposalTTL: 10000 });
      await expect(validateConfig(config)).rejects.toThrow('relay.maxConcurrentClients');
    });

    it('rejects missing sessionGraceTTL', async () => {
      const config = buildRelayConfig({ maxConcurrentClients: 4, backendDisposalTTL: 10000 });
      await expect(validateConfig(config)).rejects.toThrow('relay.sessionGraceTTL');
    });

    it('rejects missing backendDisposalTTL', async () => {
      const config = buildRelayConfig({ maxConcurrentClients: 4, sessionGraceTTL: 5000 });
      await expect(validateConfig(config)).rejects.toThrow('relay.backendDisposalTTL');
    });

    it('accepts complete relay config', async () => {
      const config = buildConfig({});
      await expect(validateConfig(config)).resolves.toBeUndefined();
    });
  });

  describe('never-expire TTL sentinels', () => {
    function buildRelayConfig(relay: any): FullConfig {
      return mergeConfig(defaultConfig, { relay });
    }

    it('accepts relay.sessionGraceTTL = 0 (never expire)', async () => {
      const config = buildRelayConfig({ ...validRelay, sessionGraceTTL: 0 });
      await expect(validateConfig(config)).resolves.toBeUndefined();
    });

    it('accepts relay.backendDisposalTTL = 0 (never expire)', async () => {
      const config = buildRelayConfig({ ...validRelay, backendDisposalTTL: 0 });
      await expect(validateConfig(config)).resolves.toBeUndefined();
    });

    it('rejects relay.sessionGraceTTL < 0', async () => {
      const config = buildRelayConfig({ ...validRelay, sessionGraceTTL: -1 });
      await expect(validateConfig(config)).rejects.toThrow('relay.sessionGraceTTL must be >= 0');
    });

    it('rejects relay.backendDisposalTTL < 0', async () => {
      const config = buildRelayConfig({ ...validRelay, backendDisposalTTL: -1 });
      await expect(validateConfig(config)).rejects.toThrow('relay.backendDisposalTTL must be >= 0');
    });

    it('accepts infrastructure.sessionTransportIdleTTL = 0 (never expire)', async () => {
      const config = buildConfig({ timeouts: { infrastructure: { sessionTransportIdleTTL: 0 } } });
      await expect(validateConfig(config)).resolves.toBeUndefined();
    });

    it('rejects infrastructure.sessionTransportIdleTTL < 0', async () => {
      const config = buildConfig({ timeouts: { infrastructure: { sessionTransportIdleTTL: -1 } } });
      await expect(validateConfig(config)).rejects.toThrow('infrastructure.sessionTransportIdleTTL must be >= 0');
    });
  });

  describe('chromium sandbox', () => {
    it('auto-sets sandbox on Linux for chrome channel', async () => {
      const config = buildConfig({});
      // Default channel is 'chrome' — on Linux, sandbox should be set to true
      if (process.platform === 'linux') {
        config.browser.launchOptions.chromiumSandbox = undefined;
        await validateConfig(config);
        expect(config.browser.launchOptions.chromiumSandbox).toBe(true);
      }
    });

    it('disables sandbox on Linux for chromium channel', async () => {
      const config = buildConfig({ browser: { launchOptions: { channel: 'chromium' } } });
      if (process.platform === 'linux') {
        config.browser.launchOptions.chromiumSandbox = undefined;
        await validateConfig(config);
        expect(config.browser.launchOptions.chromiumSandbox).toBe(false);
      }
    });

    it('auto-sets sandbox=true on non-Linux', async () => {
      const config = buildConfig({});
      if (process.platform !== 'linux') {
        config.browser.launchOptions.chromiumSandbox = undefined;
        await validateConfig(config);
        expect(config.browser.launchOptions.chromiumSandbox).toBe(true);
      }
    });
  });
});
