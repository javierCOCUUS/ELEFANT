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

  // If an existing Aspire .vtdb template exists in the repo, clone the binary and open it
  const templatePath = path.join(process.cwd(), 'tool-database', 'tools.vtdb.vectric');
  let db: any = null;
  if (fs.existsSync(templatePath)) {
    // copy binary to output path first so we preserve header/user_version/etc
    try {
      fs.copyFileSync(templatePath, outPath);
      const bufOut = fs.readFileSync(outPath);
      db = new SQL.Database(new Uint8Array(bufOut));
    } catch (err) {
      console.warn('Failed to clone template binary, creating new DB instead:', err.message || err);
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
  }

  // Ensure minimal tables exist (if template wasn't present or missing tables)
  function ensure(tableSql: string) {
    try { db.run(tableSql); } catch (e) { }
  }
  ensure(`CREATE TABLE IF NOT EXISTS tool_geometry (id TEXT PRIMARY KEY, units INTEGER, diameter REAL, num_flutes INTEGER, flute_length REAL, name_format TEXT, notes TEXT, tool_type TEXT, shank_diameter REAL, length REAL);`);
  ensure(`CREATE TABLE IF NOT EXISTS tool_cutting_data (id TEXT PRIMARY KEY, spindle_speed REAL, feed_rate REAL, rate_units INTEGER, stepover REAL, notes TEXT);`);
  ensure(`CREATE TABLE IF NOT EXISTS material (id TEXT PRIMARY KEY, name TEXT);`);
  ensure(`CREATE TABLE IF NOT EXISTS tool_entity (id TEXT PRIMARY KEY, tool_geometry_id TEXT, tool_cutting_data_id TEXT, material_id TEXT);`);
  ensure(`CREATE TABLE IF NOT EXISTS tool_tree_entry (id TEXT PRIMARY KEY, tool_geometry_id TEXT, name TEXT);`);

  const materialMap = new Map<string,string>();
  // preload existing materials from template DB to avoid UNIQUE conflicts
  try {
    const matRes = db.exec('SELECT id, name FROM material');
    if (matRes && matRes.length) {
      for (const v of matRes[0].values) {
        const id = v[0];
        const name = v[1];
        if (name) materialMap.set(String(name), String(id));
      }
    }
  } catch (e) { /* ignore if table doesn't exist yet */ }

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
      else { matId = genId('m'); materialMap.set(material, matId); insertInto(db, 'material', { id: matId, name: String(material) }); }
    }

    // insert using only columns that exist in the target DB (avoids missing-column errors)
    insertInto(db, 'tool_geometry', { id: geomId, units: 0, diameter, num_flutes: flutes, flute_length: cutLen, name_format: name, notes, tool_type: type, shank_diameter: shank, length: null });
    insertInto(db, 'tool_cutting_data', { id: cutId, spindle_speed: rpm, feed_rate: feed, rate_units: 0, stepover, notes });
    insertInto(db, 'tool_entity', { id: entId, tool_geometry_id: geomId, tool_cutting_data_id: cutId, material_id: matId });
    insertInto(db, 'tool_tree_entry', { id: treeId, tool_geometry_id: geomId, name });
  }

  // helper to insert into a table only with columns that exist in the DB
  function insertInto(dbInstance: any, table: string, values: Record<string, any>) {
    try {
      const info = dbInstance.exec(`PRAGMA table_info(${table})`);
      if (!info || info.length === 0) return;
      const cols = info[0].values.map((v: any) => v[1]);
      const useCols = Object.keys(values).filter(k => cols.includes(k));
      if (useCols.length === 0) return;
      const placeholders = useCols.map(_ => '?').join(',');
      const stmt = `INSERT INTO ${table} (${useCols.join(',')}) VALUES (${placeholders})`;
      const vals = useCols.map(c => values[c]);
      dbInstance.run(stmt, vals);
    } catch (e) { /* ignore individual insert errors */ }
  }

  const binary = db.export();
  const buffer = Buffer.from(binary);
  fs.writeFileSync(outPath, buffer);
  console.log('Wrote', outPath, 'records=', rows.length);
  db.close();
}

run().catch(err => { console.error(err); process.exit(1); });
