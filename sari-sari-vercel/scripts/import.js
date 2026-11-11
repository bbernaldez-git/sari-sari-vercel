// Usage: node --env-file=.env.local scripts/import.js products products.csv
//        node --env-file=.env.local scripts/import.js orders orders.csv
// CSVs = your Google Sheet tabs exported via File > Download > CSV
const fs = require('fs'), { parse } = require('csv-parse/sync'), { Pool } = require('pg');
const [kind, file] = process.argv.slice(2);
if (!['products', 'orders'].includes(kind) || !file) { console.log('Usage: import.js products|orders file.csv'); process.exit(1); }
const rows = parse(fs.readFileSync(file, 'utf8'), { columns: true, skip_empty_lines: true, bom: true });
const pool = new Pool({ connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL, ssl: { rejectUnauthorized: false } });
const phone = s => { let d = String(s || '').replace(/\D/g, ''); if (d.length === 12 && d.startsWith('63')) d = '0' + d.slice(2); else if (d.length === 10 && d[0] === '9') d = '0' + d; return d; };
const json = (s, f) => { try { return JSON.parse(s); } catch (e) { return f; } };
(async () => {
  let n = 0;
  for (const r of rows) {
    if (kind === 'products') {
      if (!r.ID || !r.Name) continue;
      const img = /^https:\/\/res\.cloudinary\.com\//.test(r.Image || '') ? r.Image : '';
      await pool.query(`insert into products(id,name,category,price,stock,tags,image) values ($1,$2,$3,$4,$5,$6,$7)
        on conflict (id) do update set name=$2, category=$3, price=$4, stock=$5, tags=$6, image=$7`,
        [r.ID, r.Name, r.Category || 'Other', Number(r.Price) || 0, Math.max(0, parseInt(r.Stock, 10) || 0), r.Tags || '', img]);
    } else {
      if (!r.OrderID) continue;
      const d = new Date(r.Created);
      await pool.query(`insert into orders(id,created,email,name,contact,address,method,items,total,status,missing,admin_note,note)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict (id) do nothing`,
        [r.OrderID, isNaN(d) ? new Date() : d, r.Email || '', r.Name, phone(r.Contact), r.Address || '', r.Method,
         JSON.stringify(json(r.Items, [])), Number(r.Total) || 0, r.Status || 'Pending',
         JSON.stringify(json(r.Missing, [])), r.AdminNote || '', r.Note || '']);
    }
    n++;
  }
  console.log(`Imported ${n} ${kind}.`); await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
