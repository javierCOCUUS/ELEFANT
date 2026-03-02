# Tool database

This folder contains the canonical schema and an example CSV for the CNC tool
database.

Files:

- `tools.schema.json` — JSON Schema describing the canonical columns and types.
- `tools.example.csv` — example CSV you can upload to Google Sheets to start.

How to use

1. Open Google Sheets and import `tools.example.csv` (File → Import → Upload).
2. Use the sheet as the canonical source of truth. When you update rows there
   we can implement export scripts that transform rows into Fusion/Aspire
   tool libraries.

Next steps

- I can implement a small Node.js script to read the sheet via the Google
  Sheets API and generate app-specific CSVs. Provide your Fusion/Aspire
  export examples and I'll adapt the mappers.
