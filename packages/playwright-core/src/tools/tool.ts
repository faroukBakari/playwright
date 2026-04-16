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

import type { z } from 'zod';
import type { Context } from './context';
import type * as playwright from '../../types/types';
import type { Tab } from './tab';
import type { Response } from './response';

export type { CallToolResult, CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

type ToolSchema<Input extends z.Schema> = {
  name: string;
  title: string;
  description: string;
  inputSchema: Input;
  type: 'input' | 'assertion' | 'action' | 'readOnly';
  /** Compute minimum timeout budget (ms) from raw args. Floor — user timeout cannot go below this. */
  minBudget?: (rawArgs: Record<string, unknown>) => number;
};

export type ToolCapability = 'config' | 'core' | 'core-navigation' | 'core-tabs' | 'core-input' | 'core-install' | 'network' | 'pdf' | 'storage' | 'testing' | 'vision' | 'devtools' | 'downloads';

export type FileUploadModalState = {
  type: 'fileChooser';
  description: string;
  fileChooser: playwright.FileChooser;
  clearedBy: { tool: string; skill: string };
};

export type DialogModalState = {
  type: 'dialog';
  description: string;
  dialog: playwright.Dialog;
  clearedBy: { tool: string; skill: string };
};

export type ModalState = FileUploadModalState | DialogModalState;

export type Tool<Input extends z.Schema = z.Schema> = {
  capability: ToolCapability;
  skillOnly?: boolean;
  noTabRequired?: boolean;
  schema: ToolSchema<Input>;
  handle: (context: Context, params: z.output<Input>, response: Response) => Promise<void>;
};

export function defineTool<Input extends z.Schema>(tool: Tool<Input>): Tool<Input> {
  return tool;
}

export type TabTool<Input extends z.Schema = z.Schema> = {
  capability: ToolCapability;
  skillOnly?: boolean;
  noTabRequired?: boolean;
  schema: ToolSchema<Input>;
  clearsModalState?: ModalState['type'];
  /**
   * When true, the "modal must be present" guard is skipped even when
   * clearsModalState is set. The handler is responsible for deciding what
   * to do when there is no modal. Use only for tools that support both
   * modal and non-modal operation (e.g. browser_file_upload with ref).
   */
  clearsModalStateOptional?: boolean;
  handle: (tab: Tab, params: z.output<Input>, response: Response) => Promise<void>;
};

function hasSnapshotWaitFor(params: unknown): params is { snapshotWaitFor: { text?: string; textGone?: string; selector?: string; within?: string } } {
  return typeof params === 'object' && params !== null && 'snapshotWaitFor' in params && (params as any).snapshotWaitFor != null;
}

export function defineTabTool<Input extends z.Schema>(tool: TabTool<Input>): Tool<Input> {
  return {
    ...tool,
    handle: async (context, params, response) => {
      const tab = await context.ensureTab();
      const modalStates = tab.modalStates().map(state => state.type);
      if (tool.clearsModalState && !modalStates.includes(tool.clearsModalState) && !tool.clearsModalStateOptional) {
        response.addError(`Error: The tool "${tool.schema.name}" can only be used when there is related modal state present.`);
      } else if (!tool.clearsModalState && modalStates.length) {
        response.addError(`Error: Tool "${tool.schema.name}" does not handle the modal state.`);
      } else {
        await tool.handle(tab, params, response);
        // Pass snapshotWaitFor from tool params to response for pre-snapshot waiting
        if (hasSnapshotWaitFor(params))
          response.setSnapshotWaitFor(params.snapshotWaitFor);
      }
    },
  };
}
