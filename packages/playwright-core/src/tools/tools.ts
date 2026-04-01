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

import attachTab from './attachTab';
import common from './common';
import config from './config';
import console from './console';
import cookies from './cookies';
import createTab from './createTab';
import devtools from './devtools';
import downloads from './downloads';
import dialogs from './dialogs';
import evaluate from './evaluate';
import files from './files';
import form from './form';
import keyboard from './keyboard';
import listTabs from './listTabs';
import mouse from './mouse';
import navigate from './navigate';
import network from './network';
import pdf from './pdf';
import route from './route';
import runCode from './runCode';
import snapshot from './snapshot';
import screenshot from './screenshot';
import storage from './storage';
import styles from './styles';
import tabs from './tabs';
import tracing from './tracing';
import verify from './verify';
import video from './video';
import wait from './wait';
import webstorage from './webstorage';

import type { Tool } from './tool';
import type { ContextConfig } from './context';

export const browserTools: Tool<any>[] = [
  ...attachTab,
  ...common,
  ...config,
  ...console,
  ...cookies,
  ...createTab,
  ...devtools,
  ...downloads,
  ...dialogs,
  ...evaluate,
  ...files,
  ...form,
  ...keyboard,
  ...listTabs,
  ...mouse,
  ...navigate,
  ...network,
  ...pdf,
  ...route,
  ...runCode,
  ...screenshot,
  ...snapshot,
  ...storage,
  ...styles,
  ...tabs,
  ...tracing,
  ...verify,
  ...video,
  ...wait,
  ...webstorage,
];

export function filteredTools(config: Pick<ContextConfig, 'capabilities'>) {
  return browserTools.filter(tool => tool.capability.startsWith('core') || config.capabilities?.includes(tool.capability)).filter(tool => !tool.skillOnly);
}
