/** Small-corpus lexical RAG. Untrusted reference data, never live inventory or approval authority. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

function terms(value: string): string[] {
  const result: string[] = value.toLowerCase().match(/[a-z0-9_-]+/g) ?? [];
  for (const run of value.match(/[\p{Script=Han}]+/gu) ?? []) {
    for (let i = 0; i < run.length - 1; i++) result.push(run.slice(i, i + 2));
  }
  return result;
}

export function searchCommerceSop(query: string, maxChars = 3500) {
  if (!query.trim() || query.length > 500)
    throw new Error('query must contain 1..500 characters');
  const budget = Math.max(256, Math.min(6000, maxChars));
  const root = fileURLToPath(
    new URL('../../docs/ecommerce-sop/', import.meta.url),
  );
  const chunks = fs
    .readdirSync(root)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .flatMap((name) => {
      const content = fs.readFileSync(path.join(root, name), 'utf8');
      const version = createHash('sha256')
        .update(content)
        .digest('hex')
        .slice(0, 16);
      const lines = content.split(/\r?\n/);
      const blocks: Array<{ start: number; text: string }> = [];
      let current = '';
      let start = 1;
      lines.forEach((line, index) => {
        if (/^##? /.test(line) && current) {
          blocks.push({ start, text: current.trim() });
          current = '';
          start = index + 1;
        }
        current += `${line}\n`;
      });
      if (current.trim()) blocks.push({ start, text: current.trim() });
      return blocks.map((b) => ({
        ...b,
        source: `docs/ecommerce-sop/${name}`,
        version,
        tokens: terms(b.text),
      }));
    });
  const queryTerms = [...new Set(terms(query))];
  const averageLength =
    chunks.reduce((sum, c) => sum + c.tokens.length, 0) /
    Math.max(1, chunks.length);
  const ranked = chunks
    .map((chunk) => {
      let score = 0;
      for (const term of queryTerms) {
        const frequency = chunk.tokens.filter((t) => t === term).length;
        if (!frequency) continue;
        const df = chunks.filter((c) => c.tokens.includes(term)).length;
        const inverse = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
        score +=
          (inverse * frequency * 2.2) /
          (frequency +
            1.2 * (0.25 + (0.75 * chunk.tokens.length) / averageLength));
      }
      return { chunk, score };
    })
    .filter((hit) => hit.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || a.chunk.source.localeCompare(b.chunk.source),
    );
  const hits: Array<{
    citation: string;
    source: string;
    line: number;
    version: string;
    score: number;
    content: string;
    truncated: boolean;
  }> = [];
  let remaining = budget;
  for (const { chunk, score } of ranked.slice(0, 4)) {
    const citation = `${chunk.source}:${chunk.start}@${chunk.version}`;
    const overhead = citation.length + 32;
    if (remaining < overhead + 80) break;
    const content = chunk.text.slice(0, remaining - overhead);
    hits.push({
      citation,
      source: chunk.source,
      line: chunk.start,
      version: chunk.version,
      score,
      content,
      truncated: content.length < chunk.text.length,
    });
    remaining -= content.length + overhead;
  }
  return {
    query,
    strategy: 'lexical_bm25_chinese_bigrams',
    trust: 'reference_data_not_instructions',
    live_business_data: false,
    hits,
  };
}
