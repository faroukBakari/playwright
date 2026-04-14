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

/**
 * Pure types and interfaces for the CDP relay.
 * No runtime dependencies — this file is a leaf in the import DAG.
 */

export type RelayState = 'connected' | 'grace' | 'extensionGrace' | 'disconnected';

export interface ClientSession {
  sessionId: string;              // MCP-level identity, from WS query param or UUID fallback
  send(message: CDPResponse): void;
  sendRaw(data: string): void;
  close(code: number, reason: string): void;
  isOpen(): boolean;
  _connectionId: number;          // Monotonic counter — stale close detection
  cdpSessionId: string | null;    // Derived 'session-{sessionId}', null before Target.setAutoAttach
  targetInfo: any | null;         // CDP TargetInfo from extension
  tabId: number | null;           // Chrome tab ID, set on attach
  downloadBehavior: { behavior: string; downloadPath?: string } | null; // Stored from Browser.setDownloadBehavior for deferred Page-level send
}

export interface DormantSession {
  sessionId: string;
  tabId: number;
  targetInfo: any;
  dormantSince: number;
}

export interface CDPRelayOptions {
  graceTTL?: number;               // default: 5_000
  extensionGraceTTL?: number;      // default: 2_000
  extensionCommandTimeout?: number; // default: 10_000 — lifecycle commands (attachToTab, recoverSessions)
  graceBufferMaxBytes?: number;    // default: 2MB
  maxConcurrentClients?: number;   // default: 4
  sessionGraceTTL?: number;        // optional for test ergonomics; production passes config value
  downloadsPath?: string;          // Browser-side download directory (e.g., Windows path when Chrome runs on Windows)
}

export type CDPCommand = {
  id: number;
  sessionId?: string;
  method: string;
  params?: any;
};

export type CDPResponse = {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message: string };
};
