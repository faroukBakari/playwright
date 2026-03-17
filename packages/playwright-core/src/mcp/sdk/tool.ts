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

import { z as zod } from '../../mcpBundle';
import type { z } from 'zod';
import type * as mcpServer from './server';

export type ToolSchema<Input extends z.Schema> = {
  name: string;
  title: string;
  description: string;
  inputSchema: Input;
  type: 'input' | 'assertion' | 'action' | 'readOnly';
};

export function toMcpTool(tool: ToolSchema<any>): mcpServer.Tool {
  const readOnly = tool.type === 'readOnly' || tool.type === 'assertion';
  const schema = zod.toJSONSchema(tool.inputSchema) as mcpServer.Tool['inputSchema'] & { properties?: Record<string, any> };
  // Inject universal timeout parameter — extracted at dispatch layer before schema parse
  if (schema.properties) {
    schema.properties.timeout = {
      type: 'number',
      description: 'Timeout in seconds. Default varies by tool type (5s read/input/action/assertion, 15s navigate, 30s run_code). Override when the operation needs more time.',
    };
  }
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: schema,
    annotations: {
      title: tool.title,
      readOnlyHint: readOnly,
      destructiveHint: !readOnly,
      openWorldHint: true,
    },
  };
}

export function defineToolSchema<Input extends z.Schema>(tool: ToolSchema<Input>): ToolSchema<Input> {
  return tool;
}
