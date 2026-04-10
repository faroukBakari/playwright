/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License");
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

import { Dispatcher } from './dispatcher';
import { SdkObject } from '../instrumentation';

import type { PageDispatcher } from './pageDispatcher';
import type { DispatcherScope } from './dispatcher';
import type * as channels from '@protocol/channels';
import type { Progress } from '@protocol/progress';

// Agent functionality stripped from this build.
export class PageAgentDispatcher extends Dispatcher<SdkObject, channels.PageAgentChannel, DispatcherScope> implements channels.PageAgentChannel {
  _type_PageAgent = true;
  _type_EventTarget = true;

  constructor(scope: PageDispatcher, _options: channels.PageAgentParams) {
    super(scope, new SdkObject(scope._object, 'pageAgent'), 'PageAgent', { page: scope });
  }

  async perform(_params: channels.PageAgentPerformParams, _progress: Progress): Promise<channels.PageAgentPerformResult> {
    throw new Error('Agent not available — stripped from this build');
  }

  async expect(_params: channels.PageAgentExpectParams, _progress: Progress): Promise<channels.PageAgentExpectResult> {
    throw new Error('Agent not available — stripped from this build');
  }

  async extract(_params: channels.PageAgentExtractParams, _progress: Progress): Promise<channels.PageAgentExtractResult> {
    throw new Error('Agent not available — stripped from this build');
  }

  async usage(_params: channels.PageAgentUsageParams, _progress: Progress): Promise<channels.PageAgentUsageResult> {
    return { usage: { turns: 0, inputTokens: 0, outputTokens: 0 } };
  }

  async dispose(_params: channels.PageAgentDisposeParams, progress: Progress): Promise<void> {
    progress.metadata.potentiallyClosesScope = true;
    this._dispose();
  }
}
