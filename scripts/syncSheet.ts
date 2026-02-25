import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

function parseCSV(text: string) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const splitter = /,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/;
  const parseLine = (line: string) => line.split(splitter).map(p => {
    p = p.trim();
    if (p.startsWith('"') && p.endsWith('"')) return p.slice(1, -1).replace(/""/g, '"');
    return p;
  });
  const header = parseLine(lines[0]);
  const rows: any[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseLine(lines[i]);
    const obj: any = {};
    for (let j = 0; j < header.length; j++) obj[header[j]] = vals[j] ?? '';
    rows.push(obj);
  }
  return rows;
}

function coerceNumber(s: any) {
  if (s === null || s === undefined || s === '') return null;
  const n = Number(String(s).replace(/[^0-9.\-]/g, ''));
  if (Number.isFinite(n)) return n;
  return null;
}

function slugId(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Date.now().toString().slice(-5);
}

async function run() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: ts-node scripts/syncSheet.ts <sheet-csv-url|local.csv|local.json>');
    process.exit(1);
  }
  const base = path.join(process.cwd(), 'tool-database');
  const canonicalPath = path.join(base, 'fetched_from_vtdb.json');
  let canonical: any[] = [];
  if (fs.existsSync(canonicalPath)) canonical = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));

  let sheetRows: any[] = [];
  if (arg.endsWith('.json') && fs.existsSync(arg)) {
    sheetRows = JSON.parse(fs.readFileSync(arg, 'utf8'));
  } else if (fs.existsSync(path.join(process.cwd(), arg))) {
    const text = fs.readFileSync(path.join(process.cwd(), arg), 'utf8');
    if (arg.endsWith('.csv')) sheetRows = parseCSV(text);
    else sheetRows = JSON.parse(text);
  } else if (arg.startsWith('http')) {
    const res = await fetch(arg);
    if (!res.ok) { console.error('Fetch failed', res.status); process.exit(2); }
    const text = await res.text();
    sheetRows = parseCSV(text);
  } else {
    console.error('Input not found:', arg);
    process.exit(2);
  }

  // Merge logic: match by id, else by name, else create new
  const byId = new Map(canonical.map(it => [String(it.id), it]));
  const byName = new Map(canonical.map(it => [String(it.name).toLowerCase(), it]));

  for (const r of sheetRows) {
    const id = r.id || r.ID || r.ToolID || '';
    const name = (r.name || r.Name || r.ToolName || r.Tool || '').trim();
    let target: any = null;
    if (id && byId.has(String(id))) target = byId.get(String(id));
    else if (name && byName.has(name.toLowerCase())) target = byName.get(name.toLowerCase());

    if (!target) {
      target = { id: id ? String(id) : slugId(name || 'tool'), name: name || `tool-${Date.now()}` };
      canonical.push(target);
      byId.set(String(target.id), target);
      byName.set(String(target.name).toLowerCase(), target);
    }

    // apply fields if present
    if (name) target.name = name;
    if (r.tool_type || r.Type || r.ToolType) target.tool_type = r.tool_type || r.Type || r.ToolType;
    const d = coerceNumber(r.diameter_mm ?? r.Diameter_mm ?? r.diameter ?? r.Diameter);
    if (d !== null) target.diameter_mm = d;
    const fc = coerceNumber(r.flute_count ?? r.Flutes ?? r.flute_count);
    if (fc !== null) target.flute_count = fc;
    const cl = coerceNumber(r.cutting_length_mm ?? r.CutLength_mm ?? r.cutting_length_mm);
    if (cl !== null) target.cutting_length_mm = cl;
    const sh = coerceNumber(r.shank_diameter_mm ?? r.Shank_mm);
    if (sh !== null) target.shank_diameter_mm = sh;
    const rpm = coerceNumber(r.rpm_recommend ?? r.RPM);
    if (rpm !== null) target.rpm_recommend = rpm;
    const feed = coerceNumber(r.feed_recommend_mm_per_min ?? r.Feed_mm_per_min ?? r.feed_mm_per_min);
    if (feed !== null) target.feed_recommend_mm_per_min = feed;
    const st = coerceNumber(r.stepover_percent ?? r.Stepover_pct ?? r.stepover_percent);
    if (st !== null) target.stepover_percent = st;
    if (r.material || r.Material) target.material = r.material || r.Material;
    if (r.notes || r.Notes) target.notes = r.notes || r.Notes;

    target.last_modified = new Date().toISOString();
  }

  // save backup and write canonical
  if (fs.existsSync(canonicalPath)) fs.copyFileSync(canonicalPath, canonicalPath + '.bak');
  fs.writeFileSync(canonicalPath, JSON.stringify(canonical, null, 2), 'utf8');
  console.log('Wrote canonical:', canonicalPath, 'items=', canonical.length);

  // run exporters
  console.log('Running exporters...');
  const res = spawnSync('npm', ['run', 'export:tools'], { stdio: 'inherit', shell: true });
  if (res.status !== 0) {
    console.error('Exporters failed'); process.exit(3);
  }
}

run().catch(err => { console.error(err); process.exit(1); });
