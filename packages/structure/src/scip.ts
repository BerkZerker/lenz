/**
 * Minimal SCIP (index.scip) reader. Hand-rolled protobuf decoding of the subset we need:
 *   Index { documents: repeated Document = 2 }
 *   Document { relative_path = 1, occurrences = 2, symbols = 3 }
 *   Occurrence { range = 1 (packed int32), symbol = 2, symbol_roles = 3 }
 *   SymbolInformation { symbol = 1 }
 * Definition role = 1.
 */
export interface ScipOccurrence { symbol: string; roles: number; startLine: number; startCol: number; endLine: number; endCol: number }
export interface ScipDocument { path: string; occurrences: ScipOccurrence[] }

function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n, shift = 0n;
  while (true) {
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7n;
  }
  return [result, pos];
}

function* fields(buf: Uint8Array): Generator<{ field: number; wire: number; value: bigint | Uint8Array }> {
  let pos = 0;
  while (pos < buf.length) {
    let tag: bigint; [tag, pos] = readVarint(buf, pos);
    const field = Number(tag >> 3n), wire = Number(tag & 7n);
    if (wire === 0) { let v: bigint; [v, pos] = readVarint(buf, pos); yield { field, wire, value: v }; }
    else if (wire === 2) { let len: bigint; [len, pos] = readVarint(buf, pos); const n = Number(len); yield { field, wire, value: buf.subarray(pos, pos + n) }; pos += n; }
    else if (wire === 1) { pos += 8; yield { field, wire, value: 0n }; }
    else if (wire === 5) { pos += 4; yield { field, wire, value: 0n }; }
    else throw new Error("unsupported wire type " + wire);
  }
}
const td = new TextDecoder();

export function parseScip(buf: Uint8Array): ScipDocument[] {
  const docs: ScipDocument[] = [];
  for (const f of fields(buf)) {
    if (f.field !== 2 || f.wire !== 2) continue;
    const doc: ScipDocument = { path: "", occurrences: [] };
    for (const df of fields(f.value as Uint8Array)) {
      if (df.field === 1 && df.wire === 2) doc.path = td.decode(df.value as Uint8Array);
      else if (df.field === 2 && df.wire === 2) {
        const occ: ScipOccurrence = { symbol: "", roles: 0, startLine: 0, startCol: 0, endLine: 0, endCol: 0 };
        for (const of of fields(df.value as Uint8Array)) {
          if (of.field === 1 && of.wire === 2) {
            const r: number[] = []; let p = 0; const b = of.value as Uint8Array;
            while (p < b.length) { let v: bigint; [v, p] = readVarint(b, p); r.push(Number(v)); }
            occ.startLine = r[0]; occ.startCol = r[1];
            if (r.length === 3) { occ.endLine = r[0]; occ.endCol = r[2]; } else { occ.endLine = r[2]; occ.endCol = r[3]; }
          } else if (of.field === 2 && of.wire === 2) occ.symbol = td.decode(of.value as Uint8Array);
          else if (of.field === 3 && of.wire === 0) occ.roles = Number(of.value as bigint);
        }
        doc.occurrences.push(occ);
      }
    }
    docs.push(doc);
  }
  return docs;
}
