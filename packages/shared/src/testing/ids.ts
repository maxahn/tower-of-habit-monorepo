/**
 * Deterministic ids for scenario plans.
 *
 * Seeded rather than crypto.randomUUID(): a pure evaluator test (3.15) that
 * builds the same scenario twice must get byte-identical plans, and this
 * package can't reach for Node's crypto or Math.random anyway (eslint
 * firewall). The DB layer passes a random seed when it persists, so repeated
 * runs against one database don't collide on primary keys.
 */
export type IdGen = () => string;

/** mulberry32: tiny, fast, and good enough for ids that only need to differ. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/**
 * RFC 4122 version-4-shaped UUIDs from a seed. The version nibble and variant
 * bits are set properly because z.uuid() (blockRosterMemberSchema.user_id)
 * checks them.
 */
export function idGen(seed: number): IdGen {
  const next = mulberry32(seed);
  return () => {
    const hex = Array.from({ length: 4 }, () => next().toString(16).padStart(8, '0')).join('');
    const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
    return (
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
      `${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
    );
  };
}
