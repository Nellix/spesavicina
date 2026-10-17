export function parseTesseractTsv(tsv = "") {
  const lines = new Map();
  let confidenceTotal = 0;
  let confidenceWords = 0;
  for (const row of String(tsv).split(/\r?\n/).slice(1)) {
    if (!row.trim()) continue;
    const columns = row.split("\t");
    if (columns.length < 12) continue;
    const text = columns.slice(11).join("\t").replace(/\s+/g, " ").trim();
    const confidence = Number(columns[10]);
    if (!text || !Number.isFinite(confidence) || confidence < 0) continue;
    const key = columns.slice(1, 5).join(":");
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push(text);
    confidenceTotal += confidence;
    confidenceWords += 1;
  }
  return {
    text: [...lines.values()].map((words) => words.join(" ")).join("\n"),
    confidence: confidenceWords ? Number((confidenceTotal / confidenceWords / 100).toFixed(3)) : 0,
    words: confidenceWords,
  };
}

export function isPdf(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}
