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

import fs from 'fs';
import path from 'path';
import { test, expect } from './fixtures';

test('should respect --snapshot-mode=full', async ({ startClient, server }) => {
  server.setContent('/', `<button>Button 1</button>`, 'text/html');

  const { client } = await startClient({
    args: ['--snapshot-mode=full'],
  });

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: server.PREFIX,
    },
  })).toHaveResponse({
    snapshot: expect.stringContaining(`
- button "Button 1" [ref=e2]`),
  });

  await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: `async () => {
        const button2 = document.createElement('button');
        button2.textContent = 'Button 2';
        document.body.appendChild(button2);
      }`,
    },
  });

  expect(await client.callTool({
    name: 'browser_snapshot',
  })).toHaveResponse({
    snapshot: expect.stringContaining(`
  - button "Button 1" [ref=e2]
  - button "Button 2" [ref=e3]`),
  });
});

test('should respect --snapshot-mode=incremental', async ({ startClient, server, mcpBrowser }) => {
  test.fixme(mcpBrowser === 'webkit', 'Active handling?');
  server.setContent('/', `<button>Button 1</button>`, 'text/html');

  const { client } = await startClient({
    args: ['--snapshot-mode=incremental'],
  });

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: server.PREFIX,
    },
  })).toHaveResponse({
    snapshot: expect.stringContaining(`
- button "Button 1" [ref=e2]`),
  });

  await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: `async () => {
        const button2 = document.createElement('button');
        button2.textContent = 'Button 2';
        document.body.appendChild(button2);
      }`,
    },
  });

  expect(await client.callTool({
    name: 'browser_click',
    arguments: {
      element: 'Button 2',
      ref: 'e3',
    },
  })).toHaveResponse({
    snapshot: expect.stringContaining(`
- <changed> generic [ref=e1]:
  - ref=e2 [unchanged]
  - button \"Button 2\" [active] [ref=e3]`),
  });
});

test('should respect --snapshot-mode=none', async ({ startClient, server }) => {
  server.setContent('/', `<button>Button 1</button>`, 'text/html');

  const { client } = await startClient({
    args: ['--snapshot-mode=none'],
  });

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: server.PREFIX,
    },
  })).toHaveResponse({
    page: `- Page URL: ${server.PREFIX}/`,
  });
});

test('should surface console errors with --snapshot-mode=none', async ({ startClient, server }) => {
  server.setContent('/', `
    <title>Tab one</title>
    <body>
      <button>Click me</button>
      <script>
        console.log('info message');
        console.warn('warning message');
        console.error('error message');
      </script>
    </body>
  `, 'text/html');

  const { client } = await startClient({
    args: ['--snapshot-mode=none'],
  });

  const response = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  // Errors and warnings surface even without snapshots
  expect(response).toHaveResponse({
    events: expect.stringContaining('error message'),
  });
  expect(response).toHaveResponse({
    events: expect.stringContaining('warning message'),
  });
  // Info stays suppressed
  expect(response).not.toHaveResponse({
    events: expect.stringContaining('info message'),
  });
});

test('should respect --console-level with --snapshot-mode=none', async ({ startClient, server }) => {
  server.setContent('/', `
    <title>Tab one</title>
    <body>
      <script>
        console.warn('warning message');
        console.error('error message');
      </script>
    </body>
  `, 'text/html');

  const { client } = await startClient({
    args: ['--snapshot-mode=none', '--console-level', 'error'],
  });

  const response = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  // Errors surface
  expect(response).toHaveResponse({
    events: expect.stringContaining('error message'),
  });
  // Warnings excluded by console-level filter even though high-severity
  expect(response).not.toHaveResponse({
    events: expect.stringContaining('warning message'),
  });
});

test('should respect snapshot[filename]', async ({ client, server }, testInfo) => {
  server.setContent('/', `<button>Button 1</button>`, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: server.PREFIX,
    },
  });

  expect(await client.callTool({
    name: 'browser_snapshot',
    arguments: {
      filename: 'snapshot1.yml',
    },
  })).toHaveTextResponse(expect.stringContaining('snapshot1.yml'));

  expect(await fs.promises.readFile(path.join(testInfo.outputPath(), 'snapshot1.yml'), 'utf8')).toContain(`- button "Button 1" [ref=e2]`);
});
