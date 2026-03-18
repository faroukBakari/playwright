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

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { z } from '../mcpBundle';
import { defineTool } from './tool';

const feedbackSchema = z.object({
  sessionId: z.string().describe('Claude session ID (from conversation context) for tracing this feedback to a specific work session'),
  category: z.enum([
    'ref-staleness',
    'missing-tool',
    'snapshot-gap',
    'tool-behavior',
    'performance',
    'documentation',
    'other'
  ]).describe('Category of friction encountered'),
  description: z.string().describe('What happened — the friction encountered and its impact on the workflow'),
  toolName: z.string().describe('The Playwright MCP tool that caused or is related to the friction (e.g. browser_snapshot, browser_take_screenshot)'),
  expectedBehavior: z.string().optional().describe('What should have happened instead'),
  stepsToReproduce: z.array(z.string()).optional().describe('Ordered steps to reproduce the friction'),
  workaround: z.string().optional().describe('What workaround was used, if any'),
  severity: z.enum(['low', 'medium', 'high']).default('medium').describe('Impact: low = minor inconvenience, medium = workflow disruption requiring workaround, high = blocking with no workaround'),
});

// Serialization lock — prevents interleaved writes from concurrent tool calls
let _writeLock = Promise.resolve();

async function appendFeedback(entry: Record<string, unknown>, feedbackDir: string) {
  _writeLock = _writeLock.then(async () => {
    await fs.promises.mkdir(feedbackDir, { recursive: true });
    await fs.promises.appendFile(
      path.join(feedbackDir, 'entries.jsonl'),
      JSON.stringify(entry) + '\n',
      'utf-8'
    );
  });
  return _writeLock;
}

const feedback = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_feedback',
    title: 'Submit friction feedback',
    description: 'Report friction encountered while using Playwright MCP tools. Captures structured feedback with session context for triage. Stored as append-only JSONL.',
    inputSchema: feedbackSchema,
    type: 'action',
  },

  handle: async (context, params, response) => {
    const tab = context.currentTab();
    const entry: Record<string, unknown> = {
      id: `fb-${crypto.randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      ...params,
    };

    if (tab) {
      try {
        entry.url = tab.page.url();
        entry.pageTitle = await tab.page.title();
      } catch {
        // Tab may be in a bad state — don't fail the feedback submission
      }
    }

    const feedbackDir = path.join(
      process.env.WEB_AUTOMATION_ROOT || context.options.cwd,
      'docs', 'feedback'
    );
    await appendFeedback(entry, feedbackDir);

    response.addTextResult(
      `Feedback recorded: ${entry.id}\nCategory: ${params.category}\nSeverity: ${params.severity}\nStored in: docs/feedback/entries.jsonl`
    );
  },
});

// Exported for testing
export { appendFeedback as _appendFeedbackForTest };

export default [feedback];
