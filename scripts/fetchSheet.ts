import fs from 'fs';

function extractIdAndGid(urlOrId: string): { id: string; gid: string } {
  // If full URL, extract id and gid
  const idMatch = urlOrId.match(/\/d\/([a-zA-Z0-9-_]+)/);
  let id = idMatch ? idMatch[1] : urlOrId;
  let gid = '0';
  const gidMatch = urlOrId.match(/[?&]gid=(\d+)/);
  if (gidMatch) gid = gidMatch[1];
  return { id, gid };
}

function csvFetchUrl(id: string, gid: string) {
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

function parseCSV(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const splitter = /,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/;

  function parseLine(line: string) {
    const parts = line.split(splitter).map((p) => p.trim());
    return parts.map((p) => {
      if (p.startsWith('"') && p.endsWith('"')) {
        return p.slice(1, -1).replace(/""/g, '"');
      }
      return p;
    });
  }

  const header = parseLine(lines[0]);
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseLine(lines[i]);
    const obj: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      obj[header[j]] = vals[j] ?? '';
    }
    rows.push(obj);
  }
  return rows;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: ts-node scripts/fetchSheet.ts <sheet-url-or-id> [gid]');
    process.exit(1);
  }
  const { id, gid } = extractIdAndGid(arg);
  const clientGid = process.argv[3] ?? gid;
  const url = csvFetchUrl(id, clientGid);
  console.log('Fetching CSV from:', url);
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error('Failed to fetch sheet. Status:', res.status);
      process.exit(2);
    }
    const text = await res.text();
    fs.writeFileSync('tool-database/fetched.csv', text, 'utf8');
    const rows = parseCSV(text);
    fs.writeFileSync('tool-database/fetched.json', JSON.stringify(rows, null, 2), 'utf8');
    console.log(`Saved ${rows.length} rows to tool-database/fetched.json`);
  } catch (err) {
    console.error('Error fetching sheet:', err);
    process.exit(3);
  }
}

main();
