/** RFC 4180-style CSV, including quoted commas/newlines and escaped quotes. */
export function parseCsv(source: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false, closed = false;
  const input = source.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quoted) { if (c === '"') { if (input[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } } else field += c; continue; }
    if (c === ',' || c === '\n' || c === '\r') {
      row.push(field); field = ''; closed = false;
      if (c !== ',') { if (row.some(v => v.trim())) rows.push(row); row = []; if (c === '\r' && input[i + 1] === '\n') i++; }
    } else if (c === '"' && !field && !closed) quoted = true;
    else { if (closed || c === '"') throw new Error('Invalid CSV quoting'); field += c; }
  }
  if (quoted) throw new Error('CSV has an unclosed quoted field');
  row.push(field); if (row.some(v => v.trim())) rows.push(row);
  if (!rows.length || rows.some(r => r.length !== rows[0]!.length)) throw new Error('Every CSV row must have the same columns as its header');
  return rows;
}
