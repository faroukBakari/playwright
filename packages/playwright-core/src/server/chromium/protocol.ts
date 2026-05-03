// Re-export CDP protocol types from canonical location.
// The upstream build copies types/protocol.d.ts -> lib/server/chromium/protocol.d.ts.
// We skip the build (tsx runtime), so this barrel bridges the gap.
export type { Protocol } from '../../../types/protocol';
