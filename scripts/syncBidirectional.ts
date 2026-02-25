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

async function run() {
  const argv = process.argv.slice(2);
  const sheetArg = argv[0];
  if (!sheetArg) { console.error('Usage: ts-node scripts/syncBidirectional.ts <sheet-url-or-id>'); process.exit(1); }
  const { id: spreadsheetId, gid } = extractIdAndGid(sheetArg);

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

  // load canonical
  const canonicalPath = path.join(process.cwd(), 'tool-database', 'fetched_from_vtdb.json');
  const canonical = fs.existsSync(canonicalPath) ? JSON.parse(fs.readFileSync(canonicalPath, 'utf8')) : [];

  const byId = new Map(canonical.map((it: any) => [String(it.id), it]));
  const byName = new Map(canonical.map((it: any) => [String(it.name).toLowerCase(), it]));

  // convert sheet rows to canonical-like objects
  const sheetObjs = sheetRows.map(r => ({
    id: r.id || r.ID || r.ToolID || '',
    name: r.name || r.Name || r.ToolName || '',
    tool_type: r.tool_type || r.Type || r.ToolType || '',
    diameter_mm: coerceNumber(r.diameter_mm || r.Diameter_mm || r.Diameter),
    flute_count: coerceNumber(r.flute_count || r.Flutes),
    cutting_length_mm: coerceNumber(r.cutting_length_mm || r.CutLength_mm),
    shank_diameter_mm: coerceNumber(r.shank_diameter_mm || r.Shank_mm),
    rpm_recommend: coerceNumber(r.rpm_recommend || r.RPM),
    feed_recommend_mm_per_min: coerceNumber(r.feed_recommend_mm_per_min || r.Feed_mm_per_min),
    stepover_percent: coerceNumber(r.stepover_percent || r.Stepover_pct),
    material: r.material || r.Material || '',
    notes: r.notes || r.Notes || '',
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

    // both exist: choose latest
    const tCanon = Date.parse(fromCanon.last_modified || fromCanon.lastModified || 0) || 0;
    const tSheet = Date.parse(fromSheet.last_modified || 0) || 0;
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

  // update sheet: build header from merged keys
  const headers = ['id','name','tool_type','diameter_mm','flute_count','cutting_length_mm','shank_diameter_mm','material','rpm_recommend','feed_recommend_mm_per_min','stepover_percent','notes','last_modified'];
  const values = rowsToValues(merged, headers);
  await sheets.spreadsheets.values.update({ spreadsheetId, range: range + '!A1', valueInputOption: 'USER_ENTERED', requestBody: { values } });
  console.log('Wrote back to sheet:', spreadsheetId, sheetName);

  // regenerate exports and tools DB
  console.log('Regenerating exports and tools DB...');
  spawnSync('npm', ['run', 'export:tools'], { stdio: 'inherit', shell: true });
  // generate tools.vtdb filename that Aspire requires
  const toolsOut = path.join(process.cwd(), 'tool-database', 'tools.vtdb');
  spawnSync('npx', ['ts-node','--transpile-only','scripts/aspireCsvToVtdb.ts','tool-database/exports/aspire.csv', toolsOut], { stdio: 'inherit', shell: true });
  console.log('Wrote tools DB to', toolsOut);
}

run().catch(err => { console.error(err); process.exit(1); });
