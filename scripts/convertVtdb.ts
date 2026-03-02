import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';

function toMm(value: number | null, units: number | null) {
  if (value === null || value === undefined) return null;
  if (units === 1) return value * 25.4;
  return value;
}

async function run() {
  const argv = process.argv.slice(2);
  const fileArg = argv[0] || path.join(process.cwd(), 'tool-database', 'tools.vtdb.vectric');
  if (!fs.existsSync(fileArg)) {
    console.error('File not found:', fileArg);
    process.exit(2);
  }

  const filebuffer = fs.readFileSync(fileArg);
  const SQL = await initSqlJs({ locateFile: (f: string) => require.resolve('sql.js/dist/sql-wasm.wasm') });
  const db = new SQL.Database(new Uint8Array(filebuffer));

  function rowsFor(sql: string) {
    const res = db.exec(sql);
    if (!res || res.length === 0) return [];
    const r = res[0];
    return r.values.map((vals: any[]) => {
      const obj: any = {};
      r.columns.forEach((c: string, i: number) => obj[c] = vals[i]);
      return obj;
    });
  }

  const geometries = rowsFor('SELECT * FROM tool_geometry');
  const entities = rowsFor('SELECT * FROM tool_entity');
  const cutting = rowsFor('SELECT * FROM tool_cutting_data');
  const materials = rowsFor('SELECT * FROM material');
  const trees = rowsFor('SELECT * FROM tool_tree_entry');

  const materialById = new Map(materials.map((m: any) => [m.id, m]));
  const entityByGeom = new Map(entities.map((e: any) => [e.tool_geometry_id, e]));
  const cuttingById = new Map(cutting.map((c: any) => [c.id, c]));
  const treeByGeom = new Map(trees.map((t: any) => [t.tool_geometry_id, t]));

  const out: any[] = geometries.map((g: any) => {
    const ent = entityByGeom.get(g.id) || null;
    const cut = ent ? cuttingById.get(ent.tool_cutting_data_id) || null : null;
    const mat = ent && ent.material_id ? materialById.get(ent.material_id) || null : null;
    const tree = treeByGeom.get(g.id) || null;

    const units = g.units ?? null;

    const diameter_mm = g.diameter ? toMm(g.diameter, units) : null;
    const flute_count = g.num_flutes ?? null;
    const cutting_length_mm = g.flute_length ? toMm(g.flute_length, units) : null;

    let stepover_percent: number | null = null;
    if (cut && typeof cut.stepover === 'number') {
      if (cut.stepover >= 0 && cut.stepover <= 100) stepover_percent = cut.stepover;
    }

    let feed_recommend_mm_per_min: number | null = null;
    if (cut && typeof cut.feed_rate === 'number') {
      if (cut.rate_units === 1) feed_recommend_mm_per_min = cut.feed_rate * 25.4;
      else feed_recommend_mm_per_min = cut.feed_rate;
    }

    const item: any = {};
    item.id = String(g.id);
    item.name = String(tree?.name || g.name_format || `tool-${g.id}`);
    item.tool_type = String(g.tool_type ?? '');

    // diameter is required by schema — ensure a numeric value (fallback 0)
    item.diameter_mm = typeof diameter_mm === 'number' ? diameter_mm : 0;

    if (typeof flute_count === 'number') item.flute_count = flute_count;
    if (typeof g.length === 'number') item.length_mm = g.length;
    if (typeof cutting_length_mm === 'number') item.cutting_length_mm = cutting_length_mm;
    if (typeof g.shank_diameter === 'number') item.shank_diameter_mm = g.shank_diameter;
    if (mat && mat.name) item.material = String(mat.name);
    if (g.coating) item.coating = String(g.coating);
    if (cut && typeof cut.spindle_speed === 'number') item.rpm_recommend = cut.spindle_speed;
    if (typeof feed_recommend_mm_per_min === 'number') item.feed_recommend_mm_per_min = feed_recommend_mm_per_min;
    if (typeof stepover_percent === 'number') item.stepover_percent = stepover_percent;
    const notesCombined = [g.notes, cut?.notes].filter(Boolean).join('\n');
    if (notesCombined) item.notes = String(notesCombined);
    item.source = fileArg;
    item.last_modified = new Date().toISOString();

    return item;
  });

  const outPath = path.join(process.cwd(), 'tool-database', 'fetched_from_vtdb.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log('Wrote', outPath, 'records=', out.length);

  db.close();
}

run().catch(err => { console.error(err); process.exit(1); });
