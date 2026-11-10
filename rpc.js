const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const STORE_NAME = process.env.STORE_NAME || 'Jeriel Store';
const STORE_ADDRESS = process.env.STORE_ADDRESS || '743 Block 4, Gumaoc East, San Jose Del Monte, Bulacan';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const MARKUP = Number(process.env.MARKUP || 1);
const CODE_MIN = 10, SESSION_DAYS = 7;

const pool = global.__pool || (global.__pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false }, max: 1 }));
const q = (text, params) => pool.query(text, params);
class E extends Error {}

const mailer = process.env.GMAIL_USER ? nodemailer.createTransport({ service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } }) : null;
async function mail(to, subject, text) {
  if (!mailer) throw new Error('Email is not configured');
  await mailer.sendMail({ from: `${STORE_NAME} <${process.env.GMAIL_USER}>`, to, subject, text });
}
const tryMail = async (...a) => { try { await mail(...a); return true; } catch (e) { console.error('mail', e.message); return false; } };

function normPhone(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('63')) d = '0' + d.slice(2);
  else if (d.length === 10 && d[0] === '9') d = '0' + d;
  return d;
}
const idKey = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const isAdmin = e => ADMIN_EMAILS.includes(String(e).toLowerCase());
function newOrderId() {
  const d = new Date(Date.now() + 8 * 3600e3).toISOString(); // Manila time
  return 'ORD-' + d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10) + '-' + d.slice(11, 13) + d.slice(14, 16) + d.slice(17, 19) + '-' + crypto.randomInt(10, 100);
}
async function auth(token, admin) {
  const { rows } = await q('select email from sessions where token=$1 and expires>$2', [String(token || ''), Date.now()]);
  if (!rows[0]) throw new E('Please sign in again.');
  if (admin && !isAdmin(rows[0].email)) throw new E('Admins only.');
  return rows[0];
}
const prod = r => ({ id: r.id, name: r.name, category: r.category, price: Number(r.price), stock: r.stock, image: r.image,
  tags: String(r.tags || '').split(',').map(t => t.trim()).filter(Boolean) });
const orderOut = o => ({ id: o.id, created: new Date(o.created).toISOString(), email: o.email, name: o.name, contact: o.contact,
  address: o.address, method: o.method, items: o.items, total: Number(o.total), status: o.status, missing: o.missing,
  adminNote: o.admin_note, note: o.note });

/* ---------- Admin sign-in ---------- */
async function sendCode(email) {
  email = String(email || '').trim().toLowerCase();
  if (!isAdmin(email)) throw new E('This email is not an authorized admin.');
  const code = String(crypto.randomInt(100000, 1000000));
  await q('insert into admin_codes(email,code,expires) values ($1,$2,$3) on conflict (email) do update set code=$2, expires=$3',
    [email, code, Date.now() + CODE_MIN * 60000]);
  if (!(await tryMail(email, 'Admin sign-in code: ' + code, `Your ${STORE_NAME} admin code is ${code}.\nIt expires in ${CODE_MIN} minutes.`)))
    throw new E('Could not send the email. Check the GMAIL_USER and GMAIL_APP_PASSWORD settings.');
  return { sent: true };
}
async function verifyCode(email, code) {
  email = String(email || '').trim().toLowerCase();
  const { rows } = await q('select * from admin_codes where email=$1', [email]);
  const r = rows[0];
  if (!isAdmin(email) || !r || r.code !== String(code || '').trim() || Number(r.expires) < Date.now()) throw new E('Wrong or expired code. Request a new one.');
  await q('delete from admin_codes where email=$1', [email]);
  const token = crypto.randomBytes(24).toString('hex');
  await q('insert into sessions(token,email,expires) values ($1,$2,$3)', [token, email, Date.now() + SESSION_DAYS * 86400000]);
  await q('delete from sessions where expires < $1', [Date.now()]);
  return { token, role: 'admin', email };
}
async function signOut(token) { await q('delete from sessions where token=$1', [String(token || '')]); }

/* ---------- Customer (no login) ---------- */
async function getInfo() { return { name: STORE_NAME, address: STORE_ADDRESS, cloud: process.env.CLOUDINARY_CLOUD || '', preset: process.env.CLOUDINARY_PRESET || '' }; }
async function getProducts() {
  const { rows } = await q('select * from products order by name');
  return rows.map(prod).map(p => ({ ...p, price: p.price + MARKUP }));
}
async function placeOrder(o) {
  const name = String(o.name || '').trim(), contact = normPhone(o.contact), address = String(o.address || '').trim();
  const method = o.method, cart = o.cart, email = String(o.email || '').trim().toLowerCase();
  if (name.length < 2) throw new E('Please enter your name.');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new E('Enter a valid email address or leave it blank.');
  if (!/^09\d{9}$/.test(contact)) throw new E('Enter your mobile number as 09XXXXXXXXX (11 digits).');
  if (method !== 'Pickup' && method !== 'Delivery') throw new E('Choose pickup or delivery.');
  if (method === 'Delivery' && address.length < 5) throw new E('Please enter your full delivery address.');
  if (!Array.isArray(cart) || !cart.length || cart.length > 40) throw new E('Your cart is empty.');
  const recent = await q("select 1 from orders where contact=$1 and created > now() - interval '20 seconds'", [contact]);
  if (recent.rowCount) throw new E('Please wait a few seconds before placing another order.');
  const orderId = newOrderId(), items = []; let total = 0;
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query('select * from products where id = any($1) for update', [cart.map(c => String(c.id))]);
    for (const c of cart) {
      const p = rows.find(r => r.id === c.id), qty = Math.floor(Number(c.qty));
      if (!p || !(qty >= 1 && qty <= 99)) throw new E('Invalid item in cart.');
      if (qty > p.stock) throw new E(`Only ${p.stock} left of ${p.name}. Please update your cart.`);
      const price = Number(p.price) + MARKUP;
      items.push({ id: p.id, name: p.name, price, qty }); total += price * qty;
      await client.query('update products set stock = stock - $1 where id = $2', [qty, p.id]);
    }
    await client.query('insert into orders(id,email,name,contact,address,method,items,total,note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [orderId, email, name, contact, method === 'Delivery' ? address : 'Store pickup', method, JSON.stringify(items), total, String(o.note || '').slice(0, 200)]);
    await client.query('commit');
  } catch (e) { await client.query('rollback').catch(() => {}); throw e; } finally { client.release(); }
  const mails = ADMIN_EMAILS.map(a => tryMail(a, 'New order ' + orderId, `${name} (${contact}) - ${method} - PHP ${total}`));
  if (email) mails.push(tryMail(email, `Your order ${orderId} - ${STORE_NAME}`, `Hi ${name},\n\nThank you for your order!\nOrder ID: ${orderId}\n\n` +
    items.map(i => `- ${i.qty} x ${i.name} @ PHP ${i.price} = PHP ${i.qty * i.price}`).join('\n') +
    `\n\nTotal: PHP ${total}\n${method === 'Pickup' ? 'Pick up at: ' + STORE_NAME + ' ' + STORE_ADDRESS : 'Delivery to: ' + address}\n\nWe will email you once the store confirms your order. You can also track it on our site with your order ID and mobile number.`));
  await Promise.all(mails);
  return { orderId, total };
}
async function trackOrder(orderId, contact) {
  const d = normPhone(contact), k = idKey(orderId);
  const { rows } = await q("select * from orders where upper(regexp_replace(id,'[^A-Za-z0-9]','','g')) = $1", [k]);
  if (!k || !/^09\d{9}$/.test(d) || !rows[0] || normPhone(rows[0].contact) !== d)
    throw new E('No order found. Check the order ID and use the mobile number you ordered with (09XXXXXXXXX).');
  return orderOut(rows[0]);
}
async function trackMany(items) {
  const list = (Array.isArray(items) ? items : []).slice(0, 40).map(i => ({ k: idKey(i.id), c: normPhone(i.contact) }));
  if (!list.length) return [];
  const { rows } = await q("select * from orders where created > now() - interval '30 days' and upper(regexp_replace(id,'[^A-Za-z0-9]','','g')) = any($1) order by created desc", [list.map(i => i.k)]);
  return rows.filter(o => list.some(i => i.k === idKey(o.id) && i.c === normPhone(o.contact))).map(orderOut);
}

/* ---------- Admin ---------- */
async function adminGetOrders(token) {
  await auth(token, true);
  const { rows } = await q("select * from orders where status='Pending' or created > now() - interval '7 days' order by created desc");
  return rows.map(orderOut);
}
async function adminPoll(token) {
  await auth(token, true);
  const { rows } = await q("select id,name,total,method from orders where status='Pending'");
  return rows.map(r => ({ id: r.id, name: r.name, total: Number(r.total), method: r.method }));
}
async function adminReviewOrder(token, orderId, missingIds, adminNote) {
  await auth(token, true);
  const { rows } = await q('select * from orders where id=$1', [orderId]), o = rows[0];
  if (!o) throw new E('Order not found.');
  if (o.status !== 'Pending') throw new E('This order was already reviewed.');
  const missing = o.items.filter(i => (missingIds || []).includes(i.id)), status = missing.length ? 'Incomplete' : 'Complete';
  await q('update orders set status=$1, missing=$2, admin_note=$3 where id=$4', [status, JSON.stringify(missing), String(adminNote || '').slice(0, 300), orderId]);
  let emailed = false;
  if (o.email) {
    const refund = missing.reduce((t, i) => t + i.price * i.qty, 0);
    let body = `Hi ${o.name},\n\nYour order ${orderId} is ${status.toUpperCase()}.\n`;
    if (missing.length) body += `\nMissing items:\n${missing.map(i => `- ${i.qty} x ${i.name}`).join('\n')}\nAmount deducted: PHP ${refund}\nNew total: PHP ${Number(o.total) - refund}\n`;
    if (adminNote) body += `\nNote from the store: ${adminNote}\n`;
    body += '\n' + (o.method === 'Pickup' ? 'Pick up at: ' + STORE_NAME + ' ' + STORE_ADDRESS : 'It will be delivered to ' + o.address + '.');
    emailed = await tryMail(o.email, `Order ${orderId}: ${status}`, body);
  }
  return { status, emailed };
}
async function adminGetProducts(token) {
  await auth(token, true);
  const { rows } = await q('select * from products order by category, name');
  return rows.map(prod);
}
async function adminSaveProduct(token, p) {
  await auth(token, true);
  const name = String(p.name || '').trim(), category = String(p.category || '').trim();
  const price = Number(p.price), stock = Math.floor(Number(p.stock));
  if (!name || !category) throw new E('Name and category are required.');
  if (isNaN(price) || isNaN(stock) || price < 0 || stock < 0) throw new E('Check price and stock.');
  const tags = (Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',')).map(t => String(t).trim().toLowerCase())
    .filter((t, i, a) => t && a.indexOf(t) === i).slice(0, 15).join(',');
  const img = String(p.image == null ? '__keep' : p.image);
  if (img !== '' && img !== '__keep' && (!/^https:\/\/res\.cloudinary\.com\/\S+$/.test(img) || img.length > 500)) throw new E('Image link is invalid. Please upload the image again.');
  if (p.id) {
    const r = await q('update products set name=$1, category=$2, price=$3, stock=$4, tags=$5, image = case when $6 = $7 then image else $6 end where id=$8',
      [name, category, price, stock, tags, img, '__keep', p.id]);
    if (!r.rowCount) throw new E('Product not found.');
  } else {
    await q('insert into products(id,name,category,price,stock,tags,image) values ($1,$2,$3,$4,$5,$6,$7)',
      ['P' + Date.now(), name, category, price, stock, tags, img === '__keep' ? '' : img]);
  }
  return true;
}
async function adminDeleteProduct(token, id) {
  await auth(token, true);
  const r = await q('delete from products where id=$1', [id]);
  if (!r.rowCount) throw new E('Product not found.');
  return true;
}

const fns = { getInfo, getProducts, placeOrder, trackOrder, trackMany, sendCode, verifyCode, signOut,
  adminGetOrders, adminPoll, adminReviewOrder, adminGetProducts, adminSaveProduct, adminDeleteProduct };

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { fn, args } = req.body || {};
  if (!Object.prototype.hasOwnProperty.call(fns, fn)) return res.status(404).json({ error: 'Unknown function' });
  try { res.status(200).json({ result: await fns[fn](...(Array.isArray(args) ? args : [])) }); }
  catch (e) {
    if (!(e instanceof E)) console.error(e);
    res.status(e instanceof E ? 400 : 500).json({ error: e instanceof E ? e.message : 'Something went wrong. Please try again.' });
  }
};
