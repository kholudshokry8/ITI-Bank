/**
 * Deterministic, offline "embedding": hashed bag of words and bigrams, L2-normalised.
 * It is LEXICAL, not semantic. It exists so ingestion, retrieval and tests run with no API key.
 * Real semantic embeddings come from a provider adapter (see gemini.ts).
 */
const DIM = 1024;
const STOP = new Set(
  'a an the of to in on for and or is are be by with as at from that this it its what which who how do does may must not no any all'.split(
    ' ',
  ),
);

const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, '');

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9.]+/g) ?? [])
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t.length > 0 && !STOP.has(t))
    .map(stem);
}

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function hashingEmbed(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  const toks = tokenize(text);
  const add = (feature: string, w: number) => {
    v[fnv(feature) % DIM]! += w;
  };
  toks.forEach((t, i) => {
    add(t, 1);
    if (i > 0) add(`${toks[i - 1]}_${t}`, 0.7);
  });
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export const HASHING_MODEL = 'hashing-lexical-1024';
