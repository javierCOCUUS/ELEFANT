import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';

function parseCSV(text: string) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const splitter = /,(?=(?:[^"]*"[^"]*")*[^"]*$)/;
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

function genId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
}

async function run() {
  const argv = process.argv.slice(2);
  const csvPath = argv[0] || path.join(process.cwd(), 'tool-database', 'exports', 'aspire.csv');
  const outPath = argv[1] || path.join(process.cwd(), 'tool-database', 'aspire.vtdb.vectric');

  if (!fs.existsSync(csvPath)) {
    console.error('CSV not found:', csvPath);
    process.exit(2);
  }
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCSV(text);

  const SQL = await initSqlJs({ locateFile: (f: string) => require.resolve('sql.js/dist/sql-wasm.wasm') });
  const db = new SQL.Database();

  // Minimal schema matching common Vectric .vtdb tables (not exhaustive)
  db.run(`CREATE TABLE tool_geometry (id TEXT PRIMARY KEY, units INTEGER, diameter REAL, num_flutes INTEGER, flute_length REAL, name_format TEXT, notes TEXT, tool_type TEXT, shank_diameter REAL, length REAL);`);
  db.run(`CREATE TABLE tool_cutting_data (id TEXT PRIMARY KEY, spindle_speed REAL, feed_rate REAL, rate_units INTEGER, stepover REAL, notes TEXT);`);
  db.run(`CREATE TABLE material (id TEXT PRIMARY KEY, name TEXT);`);
  db.run(`CREATE TABLE tool_entity (id TEXT PRIMARY KEY, tool_geometry_id TEXT, tool_cutting_data_id TEXT, material_id TEXT);`);
  db.run(`CREATE TABLE tool_tree_entry (id TEXT PRIMARY KEY, tool_geometry_id TEXT, name TEXT);`);

  const materialMap = new Map<string,string>();

  for (const r of rows) {
    const toolId = String(r.ToolID || r.id || genId('tool'));
    const name = String(r.ToolName || r.name || r.Name || `tool-${toolId}`);
    const type = String(r.ToolType || r.type || r.Tool || 'endmill');
    const diameter = Number((r.Diameter_mm || r.diameter_mm || r.Diameter || '').toString().trim()) || 0;
    const flutes = Number((r.Flutes || r.flute_count || '').toString().trim()) || null;
    const cutLen = Number((r.CutLength_mm || r.cutting_length_mm || '').toString().trim()) || null;
    const shank = Number((r.Shank_mm || r.shank_diameter_mm || '').toString().trim()) || null;
    const rpm = Number((r.RPM || r.rpm_recommend || '').toString().trim()) || null;
    const feed = Number((r.Feed_mm_per_min || r.feed_recommend_mm_per_min || '').toString().trim()) || null;
    const stepover = Number((r.Stepover_pct || r.stepover_percent || '').toString().trim()) || null;
    const material = r.Material || r.material || null;
    const notes = (r.Notes || r.notes || '').toString();

    const geomId = genId('g');
    const cutId = genId('c');
    const entId = genId('e');
    const treeId = genId('t');
    let matId: string | null = null;

    if (material) {
      if (materialMap.has(material)) matId = materialMap.get(material)!;
      else { matId = genId('m'); materialMap.set(material, matId); db.run('INSERT INTO material (id,name) VALUES (?,?)', [matId, String(material)]); }
    }

    db.run('INSERT INTO tool_geometry (id,units,diameter,num_flutes,flute_length,name_format,notes,tool_type,shank_diameter,length) VALUES (?,?,?,?,?,?,?,?,?,?)', [geomId, 0, diameter, flutes, cutLen, name, notes, type, shank, null]);
    db.run('INSERT INTO tool_cutting_data (id,spindle_speed,feed_rate,rate_units,stepover,notes) VALUES (?,?,?,?,?,?)', [cutId, rpm, feed, 0, stepover, notes]);
    db.run('INSERT INTO tool_entity (id,tool_geometry_id,tool_cutting_data_id,material_id) VALUES (?,?,?,?)', [entId, geomId, cutId, matId]);
    db.run('INSERT INTO tool_tree_entry (id,tool_geometry_id,name) VALUES (?,?,?)', [treeId, geomId, name]);
  }

  const binary = db.export();
  const buffer = Buffer.from(binary);
  fs.writeFileSync(outPath, buffer);
  console.log('Wrote', outPath, 'records=', rows.length);
  db.close();
}

run().catch(err => { console.error(err); process.exit(1); });
