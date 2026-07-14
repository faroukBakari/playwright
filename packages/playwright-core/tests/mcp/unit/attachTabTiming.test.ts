/**
 * Regression guard: attachTab page materialization timing and self-detach
 *
 * Background — the serialization race (T1, T2):
 *   When relay.attachTab() is called, _sendTabAttached() fires synchronously
 *   and enqueues a Target.attachedToTarget WS message to the Playwright client.
 *   However, the WS message delivery (and all downstream processing on the
 *   Playwright client side — CRPage creation, 'page' event, _onPageCreated,
 *   _currentTab assignment) runs asynchronously on a future event-loop tick.
 *   attachTab() RESOLVES before the Playwright client has received, let alone
 *   processed, that message.
 *
 *   This timing gap is the serialization race: the tool handler (attachTab.ts)
 *   calls relay.attachTab() and immediately calls response.serialize(). If
 *   _currentTab is set asynchronously (only after Target.attachedToTarget is
 *   received AND CRPage is created), the serialize() call runs before the tab
 *   is materialized, causing a snapshot miss or hang.
 *
 * Background — the zombie CRPage bug (T4, fixed):
 *   When a session switched its OWN tab, attachTab() never sent
 *   Target.detachedFromTarget for the old page to that session's WS.
 *   _notifyBumpedClient only fires for OTHER displaced clients. The old CRPage
 *   stayed alive with a dead CDP connection as _currentTab, causing
 *   captureSnapshot() to hang forever (30s timeout). Fix: self-detach
 *   notification added to attachTab() before _sendTabAttached().
 *
 * What these tests verify at the relay level:
 *   T1 — Target.attachedToTarget IS sent to the Playwright client after
 *        relay.attachTab() resolves (proves _sendTabAttached fires).
 *   T2 — The message arrives at the Playwright WS client AFTER attachTab()
 *        returns, not before — demonstrating the fire-and-forget async gap.
 *   T4 — Target.detachedFromTarget IS sent for the old tab when a session
 *        switches its own tab (regression guard for the zombie CRPage fix).
 */

import http from 'http';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';

import { CDPRelayServer } from 'playwright-core/src/mcp/cdpRelay';
import type { CDPRelayOptions } from 'playwright-core/src/mcp/cdpRelay';

// ---------------------------------------------------------------------------
// Minimal test harness (mirrors RelayTestHarness in cdpRelay.test.ts)
// ---------------------------------------------------------------------------

class TimingHarness {
  server!: http.Server;
  relay!: CDPRelayServer;

  async setup(options: CDPRelayOptions = { graceTTL: 500 }) {
    this.server = http.createServer();
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.relay = new CDPRelayServer(this.server, 'chrome', options);
  }

  async teardown() {
    this.relay?.stop();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  async connectExtension(): Promise<WebSocket> {
    const wsConn = new WebSocket(this.relay.extensionEndpoint());
    await new Promise<void>((resolve, reject) => {
      wsConn.on('open', resolve);
      wsConn.on('error', reject);
    });
    return wsConn;
  }

  async connectPlaywright(sessionId?: string): Promise<WebSocket> {
    const url = sessionId
      ? `${this.relay.cdpEndpoint()}?sessionId=${sessionId}`
      : this.relay.cdpEndpoint();
    const wsConn = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      wsConn.on('open', resolve);
      wsConn.on('error', reject);
    });
    return wsConn;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Collect all messages received on a WS connection. */
function collectMessages(ws: WebSocket): any[] {
  const msgs: any[] = [];
  ws.on('message', (data: WebSocket.RawData) => {
    msgs.push(JSON.parse(data.toString()));
  });
  return msgs;
}

/** Returns a promise that resolves when the WS receives any message
 *  whose .method matches the given string, or rejects after timeoutMs. */
function waitForMessage(ws: WebSocket, method: string, timeoutMs = 500): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeoutMs);
    ws.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === method) {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });
}
void waitForMessage;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T4/T5: CDP session routing after attachTab vs createTab
//
// Hypothesis under test:
//   After relay.attachTab(), Playwright receives Target.attachedToTarget with
//   a synthetic cdpSessionId (e.g. 'session-xyz'). Playwright creates a child
//   CDP session and sends initialization commands (e.g. Runtime.enable) through
//   it with sessionId: 'session-xyz'. The relay must:
//     1. Receive that command
//     2. Forward it to the extension as a forwardCDPCommand
//     3. Route the extension's reply back to Playwright with id matching the request
//
//   Bug hypothesis: attachTab does NOT set session.cdpSessionId from the
//   extension result (only if result.cdpSessionId is present — line 856-857),
//   while createTab always sets it (line 836). This means _sendTabAttached()
//   sets cdpSessionId to `session-${sessionId}` for attachTab. When Playwright
//   later sends a CDP command with sessionId='session-xyz', _forwardToExtension
//   strips it (line 775: session.cdpSessionId === cdpSessionId → set undefined).
//   The extension receives forwardCDPCommand with cdpSessionId=undefined and
//   calls chrome.debugger.sendCommand without a sessionId — which routes to
//   the top-level page, not a child session. This is the dead-end.
//
//   For the test: we verify that after attachTab, a CDP command through the
//   child session (sessionId = cdpSessionId from Target.attachedToTarget)
//   produces a reply on the Playwright client. If the relay dead-ends, the
//   reply never arrives → test times out → RED.
//
// T4 — attachTab child session CDP command gets a reply (EXPECTED: FAIL = RED)
// T5 — createTab child session CDP command gets a reply (control, EXPECTED: PASS)
// ---------------------------------------------------------------------------

describe('attachTab CDP session routing', () => {
  let harness: TimingHarness;

  beforeEach(async () => {
    harness = new TimingHarness();
    await harness.setup({ graceTTL: 500, graceBufferMaxBytes: 2048 });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  /**
   * Arm the extension WebSocket to handle both 'attachToTab'/'createTab'
   * and 'forwardCDPCommand' messages. Returns the cdpSessionId that was
   * used in the forwardCDPCommand (if any), captured for assertion.
   */
  function armExtension(ext: WebSocket, mode: 'attach' | 'create'): { capturedForwardCdpSessionId: { value: string | undefined } } {
    const captured = { value: undefined as string | undefined };
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());

      if (msg.method === 'attachToTab' && mode === 'attach') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: {
            tabId: 42,
            // Intentionally NOT returning cdpSessionId here — this is the
            // condition that triggers the bug: relay falls back to
            // `session-${sessionId}` via _sendTabAttached.
            targetInfo: {
              type: 'page',
              url: 'https://attach.example',
              title: 'AttachTab',
              targetId: 'target-attach-42',
              browserContextId: 'ctx-attach',
            },
          },
        }));
      }

      if (msg.method === 'createTab' && mode === 'create') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: {
            tabId: 43,
            cdpSessionId: 'ext-cdp-create-43',
            targetInfo: {
              type: 'page',
              url: 'https://create.example',
              title: 'CreateTab',
              targetId: 'target-create-43',
              browserContextId: 'ctx-create',
            },
          },
        }));
      }

      if (msg.method === 'forwardCDPCommand') {
        // Capture the cdpSessionId the relay forwarded (undefined = stripped)
        captured.value = msg.params?.cdpSessionId;
        // Simulate Chrome responding to Runtime.enable
        ext.send(JSON.stringify({
          id: msg.id,
          result: {},
        }));
      }
    });
    return { capturedForwardCdpSessionId: captured };
  }

  /**
   * Wait for a CDP reply with a specific id on a WebSocket, with timeout.
   * Returns the reply message, or null if timed out.
   */
  function waitForReply(ws: WebSocket, id: number, timeoutMs = 2000): Promise<any | null> {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      ws.on('message', (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // T4: CDP command through attachTab child session — EXPECTED TO FAIL (RED)
  //
  // After attachTab(), Playwright sends: { id:100, method:'Runtime.enable',
  // sessionId: <cdpSessionId from Target.attachedToTarget> }
  // The relay should forward it to extension and route the reply back.
  // Bug: reply never arrives → waitForReply returns null → assertion fails.
  // -------------------------------------------------------------------------
  it('T4: CDP command through attachTab child session gets a reply', async () => {
    const ext = await harness.connectExtension();
    const sessionId = 'test-session-t4';
    const pw = await harness.connectPlaywright(sessionId);
    const { capturedForwardCdpSessionId } = armExtension(ext, 'attach');

    // Register session
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(20);

    // Register Target.attachedToTarget listener BEFORE calling attachTab so
    // we don't miss the message if it arrives synchronously after the await.
    const attachedPromise = new Promise<any | null>(resolve => {
      const timer = setTimeout(() => resolve(null), 1000);
      pw.on('message', (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'Target.attachedToTarget') {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });

    // Trigger attachTab — extension returns targetInfo but NO cdpSessionId
    await harness.relay.attachTab(sessionId, 42);

    const attachedMsg = await attachedPromise;
    expect(attachedMsg).not.toBeNull();
    const extractedCdpSessionId = attachedMsg?.params?.sessionId;
    expect(extractedCdpSessionId).toBeTruthy();

    // Now send a CDP command THROUGH the child session
    // This simulates what Playwright does after receiving Target.attachedToTarget
    const replyPromise = waitForReply(pw, 100);
    pw.send(JSON.stringify({
      id: 100,
      method: 'Runtime.enable',
      params: {},
      sessionId: extractedCdpSessionId,
    }));

    const reply = await replyPromise;

    // Bug hypothesis: reply is null (timed out) because the relay dead-ends
    // the forwardCDPCommand — chrome.debugger gets sessionId=undefined and
    // the command routes to the wrong target or fails silently.
    //
    // If this assertion PASSES, the hypothesis is WRONG (good news).
    // If this assertion FAILS (reply === null), the dead-session bug is confirmed.
    expect(reply).not.toBeNull();
    expect(reply?.error).toBeUndefined();
    expect(reply?.id).toBe(100);

    // Secondary: confirm what cdpSessionId the relay forwarded to the extension.
    // If stripped (undefined), that's the bug path.
    await sleep(20); // allow forwardCDPCommand handler to fire
    // eslint-disable-next-line no-console
    console.log(`[T4] relay forwarded cdpSessionId to extension: ${JSON.stringify(capturedForwardCdpSessionId.value)}`);
    // eslint-disable-next-line no-console
    console.log(`[T4] extractedCdpSessionId from Target.attachedToTarget: ${extractedCdpSessionId}`);

    ext.close();
    pw.close();
  });

  // -------------------------------------------------------------------------
  // T5: CDP command through createTab child session — CONTROL (EXPECTED PASS)
  //
  // createTab always sets session.cdpSessionId from result.cdpSessionId
  // (line 836 in cdpRelay.ts). The child session routing should work correctly.
  // If T5 passes but T4 fails, the bug is attachTab-specific.
  // If both fail, the bug is in general synthetic session routing.
  // -------------------------------------------------------------------------
  it('T5: CDP command through createTab child session gets a reply [control — expect PASS]', async () => {
    const ext = await harness.connectExtension();
    const sessionId = 'test-session-t5';
    const pw = await harness.connectPlaywright(sessionId);
    const { capturedForwardCdpSessionId } = armExtension(ext, 'create');

    // Register session
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(20);

    // Register listener BEFORE createTab for the same reason as T4.
    const attachedPromise = new Promise<any | null>(resolve => {
      const timer = setTimeout(() => resolve(null), 1000);
      pw.on('message', (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'Target.attachedToTarget') {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });

    // Trigger createTab — extension returns cdpSessionId
    await harness.relay.createTab(sessionId, 'https://create.example');

    const attachedMsg = await attachedPromise;
    expect(attachedMsg).not.toBeNull();
    const extractedCdpSessionId = attachedMsg?.params?.sessionId;
    expect(extractedCdpSessionId).toBeTruthy();

    // Send CDP command through child session
    const replyPromise = waitForReply(pw, 200);
    pw.send(JSON.stringify({
      id: 200,
      method: 'Runtime.enable',
      params: {},
      sessionId: extractedCdpSessionId,
    }));

    const reply = await replyPromise;

    expect(reply).not.toBeNull();
    expect(reply?.error).toBeUndefined();
    expect(reply?.id).toBe(200);

    await sleep(20);
    // eslint-disable-next-line no-console
    console.log(`[T5] relay forwarded cdpSessionId to extension: ${JSON.stringify(capturedForwardCdpSessionId.value)}`);
    // eslint-disable-next-line no-console
    console.log(`[T5] extractedCdpSessionId from Target.attachedToTarget: ${extractedCdpSessionId}`);

    ext.close();
    pw.close();
  });
});

describe('attachTab page materialization timing', () => {
  let harness: TimingHarness;

  beforeEach(async () => {
    harness = new TimingHarness();
    await harness.setup({ graceTTL: 500, graceBufferMaxBytes: 2048 });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  // -------------------------------------------------------------------------
  // T1: Target.attachedToTarget IS delivered to Playwright client after
  //     relay.attachTab() resolves.
  //
  // This test confirms _sendTabAttached() fires and that the WS message
  // eventually reaches the client. If this fails, the race isn't the issue —
  // the notification itself is broken.
  // -------------------------------------------------------------------------
  it('T1: Target.attachedToTarget reaches Playwright client after attachTab resolves', async () => {
    const ext = await harness.connectExtension();
    const sessionId = 'test-session-t1';
    const pw = await harness.connectPlaywright(sessionId);
    const pwMessages = collectMessages(pw);

    // Arm extension to respond to attachToTab
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: {
            tabId: 99,
            targetInfo: {
              type: 'page',
              url: 'https://example.com',
              title: 'Example',
              targetId: 'target-t1',
              browserContextId: 'ctx-t1',
            },
          },
        }));
      }
    });

    // Trigger Target.setAutoAttach so the relay registers the session
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(20);

    // Call the sideband attachTab — this calls _sendTabAttached() synchronously
    // before returning, which enqueues a WS send to the Playwright client.
    await harness.relay.attachTab(sessionId, 99);

    // Allow event loop to deliver the WS message
    await sleep(30);

    const attached = pwMessages.find(m => m.method === 'Target.attachedToTarget');
    expect(attached).toBeDefined();
    expect(attached?.params?.sessionId).toBe('session-test-session-t1');
    expect(attached?.params?.targetInfo?.url).toBe('https://example.com');

    ext.close();
    pw.close();
  });

  // -------------------------------------------------------------------------
  // T2: The race condition — attachTab() RETURNS before the Playwright client
  //     has received Target.attachedToTarget.
  //
  // Mechanism:
  //   - attachTab() awaits the extension RPC (attachToTab) then calls
  //     _sendTabAttached() → ws.send(). ws.send() is non-blocking: it
  //     enqueues the write on the socket buffer and returns immediately.
  //   - The WS frame travels: relay socket → OS kernel → loopback → client
  //     socket → Node.js I/O callback (next event loop tick or later).
  //   - Therefore: attachTab() resolves on tick N, Playwright client receives
  //     the message on tick N+k (k ≥ 1).
  //
  // This test records the resolve timestamp of attachTab() and the receive
  // timestamp on the Playwright WS. The gap between them is the window in
  // which response.serialize() runs in the tool handler.
  //
  // Expected: gap ≥ 0ms (possibly very small on localhost, but architecturally
  // guaranteed to be non-zero). We assert the structural condition:
  // the message was NOT already in the Playwright buffer at the moment
  // attachTab() returned.
  // -------------------------------------------------------------------------
  it('T2: attachTab() returns BEFORE Playwright client receives Target.attachedToTarget', async () => {
    const ext = await harness.connectExtension();
    const sessionId = 'test-session-t2';
    const pw = await harness.connectPlaywright(sessionId);

    // Register the session by sending Target.setAutoAttach
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(20);

    // Arm extension to respond to attachToTab
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: {
            tabId: 77,
            targetInfo: {
              type: 'page',
              url: 'https://race.example',
              title: 'Race',
              targetId: 'target-t2',
              browserContextId: 'ctx-t2',
            },
          },
        }));
      }
    });

    // Set up a timestamped message collector on the Playwright WS BEFORE calling
    // attachTab, so we catch the exact moment the message arrives.
    let attachedToTargetReceiveTime: number | null = null;
    pw.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'Target.attachedToTarget')
        attachedToTargetReceiveTime = Date.now();

    });

    // Call attachTab and record the resolution timestamp
    const attachTabResolveTime = await harness.relay
        .attachTab(sessionId, 77)
        .then((result: any) => {
        // Capture time immediately upon promise resolution — before any awaits
          return { result, resolvedAt: Date.now() };
        });

    // At this exact point, attachTab has returned. The question is: has the
    // Playwright client received Target.attachedToTarget yet?
    const messageAlreadyReceived = attachedToTargetReceiveTime !== null;

    // Wait for the message to arrive (it will, just asynchronously)
    await sleep(50);
    const messageEventuallyReceived = attachedToTargetReceiveTime !== null;

    // --- Core assertions ---

    // The message eventually arrives — confirming the notification mechanism works
    expect(messageEventuallyReceived).toBe(true);

    // THE RACE: the message was NOT yet received at the moment attachTab() returned.
    // This is the architectural gap: relay sends synchronously, but WS delivery
    // is async. The tool handler's response.serialize() runs in this gap.
    //
    // On localhost loopback this can be <1ms, but it is never 0ms in Node.js
    // because ws.send() enqueues — it cannot deliver to the receiving socket
    // synchronously within the same synchronous execution frame.
    expect(messageAlreadyReceived).toBe(false);

    // Report the gap for diagnostic value
    if (attachedToTargetReceiveTime !== null) {
      const gapMs = attachedToTargetReceiveTime - attachTabResolveTime.resolvedAt;
      // Gap is always ≥ 0 (receive can't precede resolve), typically 1-5ms on localhost
      expect(gapMs).toBeGreaterThanOrEqual(0);
      // eslint-disable-next-line no-console
      console.log(
          `[T2] attachTab resolved at t=0, Target.attachedToTarget received ${gapMs}ms later. ` +
        `This ${gapMs}ms window is where serialize() runs without a materialized tab.`
      );
    }

    ext.close();
    pw.close();
  });

  // -------------------------------------------------------------------------
  // T3: Verify the cdpSessionId is set on the session BEFORE _sendTabAttached
  //     fires — meaning the message contains a valid sessionId even though the
  //     Playwright processing of it is still async.
  //
  // This rules out "the message is malformed" as the cause and confirms the
  // race is purely in Playwright's async processing of a well-formed message.
  // -------------------------------------------------------------------------
  it('T3: Target.attachedToTarget carries a valid cdpSessionId', async () => {
    const ext = await harness.connectExtension();
    const sessionId = 'test-session-t3';
    const pw = await harness.connectPlaywright(sessionId);
    const pwMessages = collectMessages(pw);

    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(20);

    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: {
            tabId: 55,
            cdpSessionId: 'ext-cdp-session-55',
            targetInfo: {
              type: 'page',
              url: 'https://t3.example',
              title: 'T3',
              targetId: 'target-t3',
              browserContextId: 'ctx-t3',
            },
          },
        }));
      }
    });

    await harness.relay.attachTab(sessionId, 55);
    await sleep(30);

    const attached = pwMessages.find(m => m.method === 'Target.attachedToTarget');
    expect(attached).toBeDefined();
    // sessionId must be non-empty — Playwright uses this to map CDP events to pages
    expect(attached?.params?.sessionId).toBeTruthy();
    // targetInfo must be attached: true
    expect(attached?.params?.targetInfo?.attached).toBe(true);
    // waitingForDebugger must be false — otherwise Playwright pauses
    expect(attached?.params?.waitingForDebugger).toBe(false);

    ext.close();
    pw.close();
  });
});

// ---------------------------------------------------------------------------
// T4: REGRESSION GUARD — attaching client must receive Target.detachedFromTarget
//     for its OLD page before receiving Target.attachedToTarget for the new one.
//
// Root cause under test:
//   When a session that ALREADY has a tab (established via createTab) calls
//   attachTab() to switch to a DIFFERENT tab:
//     1. Extension detaches debugger from the old tab (bump semantics)
//     2. Relay sends Target.attachedToTarget for the new tab to the attaching client
//     3. But the attaching client's old CRPage is now a zombie — its CDP
//        connection is dead. Playwright's _currentTab stays on the old page
//        (context.ts guard: `if (!this._currentTab)` only sets if null).
//     4. serialize() → currentTab() → old broken page → CDP commands hang forever.
//
//   The relay only sends Target.detachedFromTarget to the BUMPED CLIENT
//   (_notifyBumpedClient at cdpRelay.ts:800). It never sends it to the
//   ATTACHING client for the tab that client is leaving behind.
//   The attaching client therefore has no signal to tear down its old CRPage.
//
// What this test asserts:
//   After a session with an existing tab calls attachTab() for a different tab,
//   the attaching client's WS receives Target.detachedFromTarget for its OLD
//   page's targetId/sessionId BEFORE (or at least alongside) the
//   Target.attachedToTarget for the new page.
//
// Fixed: cdpRelay.ts:attachTab() now sends Target.detachedFromTarget to the
//   attaching client for its old page before _sendTabAttached() for the new one.
//   This regression test ensures the self-detach continues to work.
// ---------------------------------------------------------------------------

describe('T4: attachTab sends detach to attaching client for old page', () => {
  let harness: TimingHarness;

  beforeEach(async () => {
    harness = new TimingHarness();
    await harness.setup({ graceTTL: 500, graceBufferMaxBytes: 2048 });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('T4: attaching client receives Target.detachedFromTarget for old page when switching tabs', async () => {
    const ext = await harness.connectExtension();
    const sessionId = 'test-session-t4-root-cause';
    const pw = await harness.connectPlaywright(sessionId);

    // Collect ALL messages the attaching client receives, in order.
    const pwMessages: any[] = [];
    pw.on('message', (data: WebSocket.RawData) => {
      pwMessages.push(JSON.parse(data.toString()));
    });

    // Register session via Target.setAutoAttach
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(20);

    const tab1TargetId = 'target-tab1-100';
    const tab2TargetId = 'target-tab2-200';

    // Step 1: Establish an INITIAL tab via createTab.
    // Sets session.tabId, session.targetInfo, and sends
    // Target.attachedToTarget to the PW client for tab1.
    await new Promise<void>(resolve => {
      ext.on('message', function handler(data: WebSocket.RawData) {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'createTab') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: {
              tabId: 100,
              cdpSessionId: 'cdp-tab1-session',
              targetInfo: {
                type: 'page',
                url: 'https://page1.example',
                title: 'Page 1',
                targetId: tab1TargetId,
                browserContextId: 'ctx-root-cause',
              },
            },
          }));
          ext.removeListener('message', handler);
          resolve();
        }
      });
      harness.relay.createTab(sessionId, 'https://page1.example').catch(() => {});
    });

    // Allow Target.attachedToTarget for tab1 to reach the PW client
    await sleep(30);

    const firstAttach = pwMessages.find(m => m.method === 'Target.attachedToTarget');
    expect(firstAttach).toBeDefined();
    expect(firstAttach?.params?.targetInfo?.targetId).toBe(tab1TargetId);
    const oldCdpSessionId: string = firstAttach?.params?.sessionId;
    expect(oldCdpSessionId).toBeTruthy();

    // Snapshot message count before the tab switch
    const msgCountBeforeSwitch = pwMessages.length;

    // Step 2: Switch to a DIFFERENT tab (tab2) via attachTab.
    // No bumpedSessionId — this session is not displacing another client,
    // it's just moving its own association to a new tab.
    await new Promise<void>(resolve => {
      ext.on('message', function handler(data: WebSocket.RawData) {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'attachToTab') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: {
              tabId: 200,
              cdpSessionId: 'cdp-tab2-session',
              targetInfo: {
                type: 'page',
                url: 'https://page2.example',
                title: 'Page 2',
                targetId: tab2TargetId,
                browserContextId: 'ctx-root-cause',
              },
              // No bumpedSessionId — this session is switching its own tab
            },
          }));
          ext.removeListener('message', handler);
          resolve();
        }
      });
      harness.relay.attachTab(sessionId, 200).catch(() => {});
    });

    // Allow WS messages to propagate
    await sleep(50);

    // --- Core assertion (RED phase) ---
    //
    // After switching from tab1 to tab2, the attaching client must receive
    // Target.detachedFromTarget for the OLD page (oldCdpSessionId / tab1TargetId).
    // This is required so Playwright can tear down the zombie CRPage and allow
    // _currentTab to be reassigned to the new page.
    //
    // On CURRENT CODE: no such message is ever sent to the attaching client.
    // _notifyBumpedClient (cdpRelay.ts:800) only fires for bumpedSessionId
    // (a different client that was displaced). When a session switches its
    // OWN tab, there is no bumpedSessionId and no detach is sent to self.
    //
    // This assertion SHOULD FAIL on current code → confirms the root cause.
    const newMessages = pwMessages.slice(msgCountBeforeSwitch);

    // eslint-disable-next-line no-console
    console.log('[T4] Post-switch messages received by attaching client:',
        JSON.stringify(newMessages.map(m => ({
          method: m.method,
          sessionId: m.params?.sessionId,
          targetId: m.params?.targetId,
        })), null, 2));
    // eslint-disable-next-line no-console
    console.log('[T4] oldCdpSessionId (tab1):', oldCdpSessionId);
    // eslint-disable-next-line no-console
    console.log('[T4] tab1TargetId:', tab1TargetId, '| tab2TargetId:', tab2TargetId);

    const detachForOldPage = newMessages.find(
        m => m.method === 'Target.detachedFromTarget' &&
             (m.params?.sessionId === oldCdpSessionId ||
              m.params?.targetId === tab1TargetId)
    );

    // Regression guard: relay sends detach to attaching client for old tab
    expect(detachForOldPage).toBeDefined();

    // Sanity: the new attach must still arrive (relay sends this correctly)
    const newAttach = newMessages.find(
        m => m.method === 'Target.attachedToTarget' &&
             m.params?.targetInfo?.targetId === tab2TargetId
    );
    expect(newAttach).toBeDefined();

    ext.close();
    pw.close();
  });
});
