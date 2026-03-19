/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { spawn } from 'child_process';
import fs from 'fs';

import * as protocol from './protocol';
import { serverLog } from './log';

/**
 * Launch Chrome with the extension connect URL to establish the bridge.
 * Extracted from CDPRelayServer to keep the relay focused on WebSocket routing.
 */
export function launchBrowserToExtension(extensionEndpoint: string, forceNewTab: boolean): void {
  // ia-custom: Extension ID is configurable via env var for test compatibility.
  // Default: our unpacked extension ID (stable per deploy dir %LOCALAPPDATA%\playwright-mcp-bridge\).
  // Upstream published ID: mmlmfjhmonkocbjadbfplnigmagldckm
  // Tests inject the published key into the manifest, producing the published ID —
  // set PLAYWRIGHT_MCP_EXTENSION_ID to match.
  const extensionId = process.env.PLAYWRIGHT_MCP_EXTENSION_ID || 'fjaaeokdflnbifiadcgneihbpkmmlikp';
  const url = new URL(`chrome-extension://${extensionId}/connect.html`);
  url.searchParams.set('mcpRelayUrl', extensionEndpoint);
  const client = {
    name: 'Playwright Agent',
    // ia-custom: ../../ resolves to playwright-core/ in monorepo layout
    // (upstream uses ../../../ which resolves to package root in published npm)
    version: require('../../package.json').version,
  };
  url.searchParams.set('client', JSON.stringify(client));
  url.searchParams.set('protocolVersion', process.env.PWMCP_TEST_PROTOCOL_VERSION ?? protocol.VERSION.toString());
  if (forceNewTab)
    url.searchParams.set('newTab', 'true');
  const token = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  if (token)
    url.searchParams.set('token', token);

  serverLog('lifecycle', `extension mode: opening connect URL in browser`);
  openUrlInChrome(url.toString());
}

export function openUrlInChrome(url: string): void {
  const isWSL = (() => {
    try {
      return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
    } catch {
      return false;
    }
  })();

  if (isWSL) {
    // WSL: PowerShell finds Chrome via Windows app registry — no exe path needed
    spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process 'chrome' -ArgumentList '${url}'`], {
      windowsHide: true,
      detached: true,
      shell: false,
      stdio: 'ignore',
    }).unref();
  } else if (process.platform === 'darwin') {
    // macOS: Launch Services finds Chrome
    spawn('open', ['-a', 'Google Chrome', url], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } else {
    // Native Linux: direct chrome invocation (xdg-open can't handle chrome-extension:// scheme)
    const candidates = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'];
    let launched = false;
    for (const bin of candidates) {
      try {
        spawn(bin, [url], { detached: true, stdio: 'ignore' }).unref();
        launched = true;
        break;
      } catch {
        // try next candidate
      }
    }
    if (!launched)
      throw new Error('Chrome/Chromium not found. Install Chrome or set a browser channel.');
  }
}
