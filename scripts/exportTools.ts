import fs from 'fs';
import path from 'path';

function csvEscape(v: any) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('\n') || s.includes('"')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function writeCsv(rows: any[], headers: string[], outPath: string) {
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map(h => csvEscape(r[h] ?? '')).join(','));
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
}

function toFusionRows(items: any[]) {
  return items.map(it => ({
    id: it.id,
    name: it.name,
    type: it.tool_type,
    diameter_mm: it.diameter_mm,
    flute_count: it.flute_count ?? '',
    cutting_length_mm: it.cutting_length_mm ?? '',
    shank_diameter_mm: it.shank_diameter_mm ?? '',
    rpm: it.rpm_recommend ?? '',
    feed_mm_per_min: it.feed_recommend_mm_per_min ?? '',
    stepover_percent: it.stepover_percent ?? '',
    material: it.material ?? '',
    notes: it.notes ?? ''
  }));
}

function toAspireRows(items: any[]) {
  return items.map(it => ({
    ToolID: it.id,
    ToolName: it.name,
    ToolType: it.tool_type,
    Diameter_mm: it.diameter_mm,
    Flutes: it.flute_count ?? '',
    CutLength_mm: it.cutting_length_mm ?? '',
    Shank_mm: it.shank_diameter_mm ?? '',
    RPM: it.rpm_recommend ?? '',
    Feed_mm_per_min: it.feed_recommend_mm_per_min ?? '',
    Stepover_pct: it.stepover_percent ?? '',
    Material: it.material ?? '',
    Notes: it.notes ?? ''
  }));
}

async function run() {
  const base = path.join(process.cwd(), 'tool-database');
  const inPath = path.join(base, 'fetched_from_vtdb.json');
  if (!fs.existsSync(inPath)) {
    console.error('Input not found:', inPath);
    process.exit(2);
  }
  const items = JSON.parse(fs.readFileSync(inPath, 'utf8'));

  const fusionRows = toFusionRows(items);
  const aspireRows = toAspireRows(items);

  const outDir = path.join(base, 'exports');
  writeCsv(fusionRows, Object.keys(fusionRows[0] || {}), path.join(outDir, 'fusion.csv'));
  writeCsv(aspireRows, Object.keys(aspireRows[0] || {}), path.join(outDir, 'aspire.csv'));

  console.log('Wrote exports:', path.join(outDir, 'fusion.csv'), path.join(outDir, 'aspire.csv'));
}

run().catch(err => { console.error(err); process.exit(1); });
