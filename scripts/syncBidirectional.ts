import fs from 'fs';
import path from 'path';
import readline from 'readline';
import {google} from 'googleapis';
import open from 'open';
import {spawnSync} from 'child_process';

function extractIdAndGid(urlOrId: string): { id: string; gid: string } {
  const idMatch = urlOrId.match(/\/d\/([a-zA-Z0-9-_]+)/);
  let id = idMatch ? idMatch[1] : urlOrId;
  let gid = '0';
  const gidMatch = urlOrId.match(/[?&]gid=(\d+)/);
  if (gidMatch) gid = gidMatch[1];
  return { id, gid };
}

function rowsToValues(rows: any[], headers: string[]) {
  const vals = [headers];
  for (const r of rows) {
    vals.push(headers.map(h => r[h] ?? ''));
  }
  return vals;
}

function csvEscape(v: any) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('\n') || s.includes('"')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function writeCsv(rows: any[], headers: string[], outPath: string) {
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map(h => csvEscape(r[h] ?? '')).join(','));
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
}

const SYNC_HEADERS = [
  'id',
  'name',
  'tool_type',
  'diameter_mm',
  'flute_count',
  'length_mm',
  'cutting_length_mm',
  'shank_diameter_mm',
  'material',
  'coating',
  'rpm_recommend',
  'feed_recommend_mm_per_min',
  'stepover_percent',
  'notes',
  'source',
  'last_modified'
];

async function authorize() {
  const credPath = path.join(process.cwd(), 'tool-database', 'oauth_client.json');
  if (!fs.existsSync(credPath)) {
    console.error('Missing OAuth client credentials. Create a Google OAuth client credentials JSON and save as tool-database/oauth_client.json');
    console.error('See https://developers.google.com/workspace/guides/create-credentials for instructions.');
    process.exit(2);
  }
  const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const clientId = creds.installed?.client_id || creds.web?.client_id;
  const clientSecret = creds.installed?.client_secret || creds.web?.client_secret;
  const redirectUri = creds.installed?.redirect_uris?.[0] || 'urn:ietf:wg:oauth:2.0:oob';
  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const tokenPath = path.join(process.cwd(), 'tool-database', 'token.json');
  if (fs.existsSync(tokenPath)) {
    const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
  }

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/spreadsheets']
  });
  console.log('Opening browser to authorize the app. If it does not open, visit this URL:');
  console.log(authUrl);
  try { await open(authUrl); } catch (e) { /* ignore */ }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise<string>(res => rl.question('Enter the authorization code: ', ans => { rl.close(); res(ans.trim()); }));
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), 'utf8');
  console.log('Saved token to', tokenPath);
  return oAuth2Client;
}

function parseSheetValues(values: any[][]) {
  if (!values || values.length === 0) return [];
  const header = values[0].map((h: any) => String(h).trim());
  const rows: any[] = [];
  for (let i = 1; i < values.length; i++) {
    const row: any = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = values[i][j] ?? '';
    rows.push(row);
  }
  return rows;
}

function coerceNumber(s: any) {
  if (s === null || s === undefined || s === '') return null;
  const n = Number(String(s).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function iso(t: any) {
  if (!t) return null;
  const d = new Date(t);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function normalizeComparable(item: any) {
  return {
    id: String(item.id || ''),
    name: String(item.name || ''),
    tool_type: String(item.tool_type || ''),
    diameter_mm: item.diameter_mm ?? null,
    flute_count: item.flute_count ?? null,
    length_mm: item.length_mm ?? null,
    cutting_length_mm: item.cutting_length_mm ?? null,
    shank_diameter_mm: item.shank_diameter_mm ?? null,
    material: item.material ?? '',
    coating: item.coating ?? '',
    rpm_recommend: item.rpm_recommend ?? null,
    feed_recommend_mm_per_min: item.feed_recommend_mm_per_min ?? null,
    stepover_percent: item.stepover_percent ?? null,
    notes: item.notes ?? ''
  };
}

function mergeImportedWithPrevious(imported: any[], previous: any[]) {
  const byIdPrev = new Map(previous.map((it: any) => [String(it.id), it]));
  const byNamePrev = new Map(previous.map((it: any) => [String(it.name || '').toLowerCase(), it]));
  const now = new Date().toISOString();

  return imported.map((it: any) => {
    const prev = byIdPrev.get(String(it.id)) || byNamePrev.get(String(it.name || '').toLowerCase());
    if (!prev) return { ...it, last_modified: iso(it.last_modified) || now };

    const same = JSON.stringify(normalizeComparable(prev)) === JSON.stringify(normalizeComparable(it));
    if (same) return { ...prev, ...it, last_modified: iso(prev.last_modified) || now };
    return { ...prev, ...it, last_modified: now };
  });
}

async function run() {
  const argv = process.argv.slice(2);
  const sheetArg = argv[0];
  if (!sheetArg) { console.error('Usage: ts-node scripts/syncBidirectional.ts <sheet-url-or-id>'); process.exit(1); }
  const { id: spreadsheetId, gid } = extractIdAndGid(sheetArg);

  const basePath = path.join(process.cwd(), 'tool-database');
  const canonicalPath = path.join(basePath, 'fetched_from_vtdb.json');
  const toolsExamplePath = path.join(basePath, 'tools.example.csv');
  const herramientasPath = path.join(basePath, 'herramientas.vtdb');
  const toolsOutPath = path.join(basePath, 'tools.vtdb');

  const previousCanonical = fs.existsSync(canonicalPath) ? JSON.parse(fs.readFileSync(canonicalPath, 'utf8')) : [];

  // Always pull latest from herramientas.vtdb first so local Aspire edits also sync out.
  if (fs.existsSync(herramientasPath)) {
    const fromVtdb = spawnSync('npx', ['ts-node', '--transpile-only', 'scripts/convertVtdb.ts', 'tool-database/herramientas.vtdb'], { stdio: 'inherit', shell: true });
    if (fromVtdb.status !== 0) {
      console.error('Failed importing herramientas.vtdb');
      process.exit(3);
    }
  }

  const importedCanonical = fs.existsSync(canonicalPath) ? JSON.parse(fs.readFileSync(canonicalPath, 'utf8')) : [];
  const canonical = mergeImportedWithPrevious(importedCanonical, previousCanonical);

  const authClient = await authorize();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  // Find sheet name for gid
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  let sheetName = meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
  if (gid) {
    for (const s of meta.data.sheets || []) {
      if (String(s.properties?.sheetId) === String(gid)) { sheetName = s.properties?.title || sheetName; break; }
    }
  }

  const range = `'${sheetName}'`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const sheetValues = res.data.values || [];
  const sheetRows = parseSheetValues(sheetValues);

  const byId = new Map(canonical.map((it: any) => [String(it.id), it]));
  const byName = new Map(canonical.map((it: any) => [String(it.name).toLowerCase(), it]));

  // convert sheet rows to canonical-like objects
  const sheetObjs = sheetRows.map(r => ({
    id: r.id || r.ID || r.ToolID || '',
    name: r.name || r.Name || r.ToolName || '',
    tool_type: r.tool_type || r.Type || r.ToolType || '',
    diameter_mm: coerceNumber(r.diameter_mm || r.Diameter_mm || r.Diameter),
    flute_count: coerceNumber(r.flute_count || r.Flutes),
    length_mm: coerceNumber(r.length_mm || r.Length_mm || r.Length),
    cutting_length_mm: coerceNumber(r.cutting_length_mm || r.CutLength_mm),
    shank_diameter_mm: coerceNumber(r.shank_diameter_mm || r.Shank_mm),
    coating: r.coating || r.Coating || '',
    rpm_recommend: coerceNumber(r.rpm_recommend || r.RPM),
    feed_recommend_mm_per_min: coerceNumber(r.feed_recommend_mm_per_min || r.Feed_mm_per_min),
    stepover_percent: coerceNumber(r.stepover_percent || r.Stepover_pct),
    material: r.material || r.Material || '',
    notes: r.notes || r.Notes || '',
    source: r.source || r.Source || '',
    last_modified: iso(r.last_modified || r.Last_Modified || r.lastModified) || null,
    __from_sheet: true
  }));

  // merge latest-wins by `id` or `name`
  const allKeys = new Set<string>();
  canonical.forEach((it: any) => allKeys.add(String(it.id)));
  sheetObjs.forEach((s: any) => { if (s.id) allKeys.add(String(s.id)); else if (s.name) allKeys.add(String(s.name).toLowerCase()); });

  const merged: any[] = [];

  for (const key of allKeys) {
    const fromCanon = byId.get(key) || byName.get(key.toLowerCase());
    const fromSheet = sheetObjs.find(s => (s.id && String(s.id) === key) || (s.name && s.name.toLowerCase() === key.toLowerCase()));

    if (!fromCanon && fromSheet) { // sheet only
      const newItem = { ...fromSheet };
      newItem.id = newItem.id || (`sheet-${Date.now().toString().slice(-6)}`);
      newItem.last_modified = newItem.last_modified || new Date().toISOString();
      merged.push(newItem);
      continue;
    }
    if (fromCanon && !fromSheet) { merged.push(fromCanon); continue; }
    if (!fromCanon || !fromSheet) { continue; }

    // both exist: choose latest
    const canonIso = iso(fromCanon.last_modified || fromCanon.lastModified) || '';
    const sheetIso = iso(fromSheet.last_modified) || '';
    const tCanon = (canonIso && Date.parse(canonIso)) || 0;
    const tSheet = (sheetIso && Date.parse(sheetIso)) || 0;
    if (tSheet > tCanon) {
      const newItem = { ...fromCanon, ...fromSheet };
      newItem.last_modified = new Date().toISOString();
      merged.push(newItem);
    } else {
      merged.push(fromCanon);
    }
  }

  // write canonical backup and file
  if (fs.existsSync(canonicalPath)) fs.copyFileSync(canonicalPath, canonicalPath + '.bak');
  fs.writeFileSync(canonicalPath, JSON.stringify(merged, null, 2), 'utf8');
  console.log('Wrote canonical:', canonicalPath, 'items=', merged.length);

  // keep local tools.example.csv synchronized with the merged canonical data
  writeCsv(merged, SYNC_HEADERS, toolsExamplePath);
  console.log('Wrote local CSV:', toolsExamplePath);

  // update Google Sheet with same canonical headers/content
  const values = rowsToValues(merged, SYNC_HEADERS);
  await sheets.spreadsheets.values.update({ spreadsheetId, range: range + '!A1', valueInputOption: 'USER_ENTERED', requestBody: { values } });
  console.log('Wrote back to sheet:', spreadsheetId, sheetName);

  // regenerate exports and tools DB
  console.log('Regenerating exports and tools DB...');
  spawnSync('npm', ['run', 'export:tools'], { stdio: 'inherit', shell: true });
  // write both outputs for compatibility with your existing workflow
  spawnSync('npx', ['ts-node','--transpile-only','scripts/aspireCsvToVtdb.ts','tool-database/exports/aspire.csv', herramientasPath], { stdio: 'inherit', shell: true });
  spawnSync('npx', ['ts-node','--transpile-only','scripts/aspireCsvToVtdb.ts','tool-database/exports/aspire.csv', toolsOutPath], { stdio: 'inherit', shell: true });
  console.log('Wrote tools DB to', herramientasPath, 'and', toolsOutPath);
}

run().catch(err => { console.error(err); process.exit(1); });
