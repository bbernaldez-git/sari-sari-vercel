const crypto = require('crypto');

const STORE_NAME = process.env.STORE_NAME || 'Jeriel Store';
const STORE_ADDRESS = process.env.STORE_ADDRESS || '743 Block 4, Gumaoc East, San Jose Del Monte, Bulacan';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const MARKUP = Number(process.env.MARKUP || 1);
const CODE_MIN = 10, SESSION_DAYS = 7, ONLINE_MS = 90000;
const STORE_ROLES = ['admin', 'cashier'];

/* Tables are created automatically the first time the API runs (safe to run again). */
const SCHEMA = `
create table if not exists products (id text primary key, name text not null, category text not null,
  price numeric not null check (price >= 0), stock int not null check (stock >= 0), tags text not null default '', image text not null default '');
create table if not exists orders (id text primary key, created timestamptz not null default now(), email text not null default '',
  name text not null, contact text not null, address text not null default '', method text not null, items jsonb not null, total numeric not null,
  status text not null default 'Pending', missing jsonb not null default '[]', admin_note text not null default '', note text not null default '');
alter table orders add column if not exists rider text not null default '';
alter table orders add column if not exists delivery_status text not null default '';
create index if not exists orders_created_idx on orders (created desc);
create index if not exists orders_contact_idx on orders (contact);
create table if not exists admin_codes (email text primary key, code text not null, expires bigint not null);
create table if not exists sessions (token text primary key, email text not null, expires bigint not null);
create table if not exists staff (email text primary key, rid text unique not null, name text not null, role text not null,
  phone text not null default '', pass text not null, active boolean not null default true, last_seen bigint not null default 0);`;

let pool, ready;
const getPool = () => pool || (pool = new (require('pg').Pool)({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL, ssl: { rejectUnauthorized: false }, max: 1 }));
const q = (text, params) => getPool().query(text, params);
const init = () => ready || (ready = q(SCHEMA).catch(e => { ready = null; throw e; }));
class E extends Error {}

/* ---------- Email (optional): Resend or Gmail; skipped silently if neither is set ---------- */
async function mail(to, subject, text) {
  if (process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `${STORE_NAME} <${process.env.MAIL_FROM || 'onboarding@resend.dev'}>`, to: [to], subject, text }) });
    if (!res.ok) throw new Error('Resend: ' + (await res.text()));
    return;
  }
  if (!process.env.GMAIL_USER) throw new Error('Email is not configured');
  const t = require('nodemailer').createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
  await t.sendMail({ from: `${STORE_NAME} <${process.env.GMAIL_USER}>`, to, subject, text });
}
const tryMail = async (...a) => { try { await mail(...a); return true; } catch (e) { console.error('mail', e.message); return false; } };
const emailOn = () => !!(process.env.RESEND_API_KEY || process.env.GMAIL_USER);

/* ---------- Helpers ---------- */
function normPhone(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('63')) d = '0' + d.slice(2);
  else if (d.length === 10 && d[0] === '9') d = '0' + d;
  return d;
}
const idKey = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const isOwner = e => ADMIN_EMAILS.includes(String(e).toLowerCase());
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const hashPw = pw => { const s = crypto.randomBytes(8).toString('hex'); return s + ':' + crypto.scryptSync(String(pw), s, 32).toString('hex'); };
function checkPw(pw, stored) {
  const [s, h] = String(stored).split(':'); if (!s || !h) return false;
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(String(pw), s, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function newOrderId() {
  const d = new Date(Date.now() + 8 * 3600e3).toISOString(); // Manila time
  return 'ORD-' + d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10) + '-' + d.slice(11, 13) + d.slice(14, 16) + d.slice(17, 19) + '-' + crypto.randomInt(10, 100);
}
/* Checks the session and the role. Every signed-in call also marks delivery/cashier staff as online. */
async function auth(token, roles) {
  const { rows } = await q('select email from sessions where token=$1 and expires>$2', [String(token || ''), Date.now()]);
  if (!rows[0]) throw new E('Please sign in again.');
  const email = rows[0].email; let role = 'admin', staff = null;
  if (!isOwner(email)) {
    const s = await q('select * from staff where email=$1 and active', [email]);
    if (!s.rows[0]) throw new E('Please sign in again.');
    staff = s.rows[0]; role = staff.role;
    await q('update staff set last_seen=$1 where email=$2', [Date.now(), email]);
  }
  if (roles && !roles.includes(role)) throw new E('Your role is not allowed to do this.');
  return { email, role, staff };
}
async function createSession(email, role, name) {
  const token = crypto.randomBytes(24).toString('hex');
  await q('insert into sessions(token,email,expires) values ($1,$2,$3)', [token, email, Date.now() + SESSION_DAYS * 86400000]);
  await q('delete from sessions where expires < $1', [Date.now()]);
  return { token, role, email, name };
}
const prod = r => ({ id: r.id, name: r.name, category: r.category, price: Number(r.price), stock: r.stock, image: r.image,
  tags: String(r.tags || '').split(',').map(t => t.trim()).filter(Boolean) });
async function riderMap() {
  const { rows } = await q("select rid,name,phone from staff where role='delivery'");
  const m = {}; rows.forEach(r => m[r.rid] = { id: r.rid, name: r.name, phone: r.phone }); return m;
}
const orderOut = (o, rm) => ({ id: o.id, created: new Date(o.created).toISOString(), email: o.email, name: o.name, contact: o.contact,
  address: o.address, method: o.method, items: o.items, total: Number(o.total), status: o.status, missing: o.missing,
  adminNote: o.admin_note, note: o.note, deliveryStatus: o.delivery_status,
  rider: o.rider ? ((rm || {})[o.rider] || { id: o.rider, name: 'Rider', phone: '' }) : null });

/* ---------- Sign-in ---------- */
async function sendCode(email) {
  email = String(email || '').trim().toLowerCase();
  if (!isOwner(email)) throw new E('Email codes are only for the store owner. Staff sign in with a password.');
  const code = String(crypto.randomInt(100000, 1000000));
  await q('insert into admin_codes(email,code,expires) values ($1,$2,$3) on conflict (email) do update set code=$2, expires=$3',
    [email, code, Date.now() + CODE_MIN * 60000]);
  if (!(await tryMail(email, 'Sign-in code: ' + code, `Your ${STORE_NAME} code is ${code}.\nIt expires in ${CODE_MIN} minutes.`)))
    throw new E('Email is not set up. Use your password instead.');
  return { sent: true };
}
async function verifyCode(email, code) {
  email = String(email || '').trim().toLowerCase();
  const { rows } = await q('select * from admin_codes where email=$1', [email]), r = rows[0];
  if (!isOwner(email) || !r || r.code !== String(code || '').trim() || Number(r.expires) < Date.now()) throw new E('Wrong or expired code. Request a new one.');
  await q('delete from admin_codes where email=$1', [email]);
  return createSession(email, 'admin', 'Owner');
}
async function loginPassword(email, password) {
  email = String(email || '').trim().toLowerCase();
  const pw = process.env.ADMIN_PASSWORD || '';
  if (pw && isOwner(email) && crypto.timingSafeEqual(sha(password), sha(pw))) return createSession(email, 'admin', 'Owner');
  const { rows } = await q('select * from staff where email=$1 and active', [email]), s = rows[0];
  if (s && checkPw(password, s.pass)) {
    await q('update staff set last_seen=$1 where email=$2', [Date.now(), email]);
    return createSession(email, s.role, s.name);
  }
  await new Promise(ok => setTimeout(ok, 1500));
  throw new E('Wrong email or password.');
}
async function signOut(token) {
  const { rows } = await q('select email from sessions where token=$1', [String(token || '')]);
  if (rows[0]) await q('update staff set last_seen=0 where email=$1', [rows[0].email]);
  await q('delete from sessions where token=$1', [String(token || '')]);
}

/* ---------- Customer (no login) ---------- */
async function getInfo() {
  return { name: STORE_NAME, address: STORE_ADDRESS, cloud: process.env.CLOUDINARY_CLOUD || '', preset: process.env.CLOUDINARY_PRESET || '', emailCodes: emailOn() };
}
/* ---------- async function getProducts() {
  const { rows } = await q('select * from products order by name');
  return rows.map(prod).map(p => ({ ...p, price: p.price + MARKUP }));
}---------- */
async function getProducts() {
  const { rows } = await q('select * from products order by name');
  // Ensure rows is always an array before mapping
  const safeRows = rows || [];
  return safeRows.map(prod).map(p => ({ ...p, price: p.price + MARKUP }));
}
async function getRiders() {
  const { rows } = await q("select rid,name,phone,last_seen from staff where role='delivery' and active order by name");
  return rows.map(r => ({ id: r.rid, name: r.name, phone: r.phone, online: Number(r.last_seen) > Date.now() - ONLINE_MS }));
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
  let rider = '';
  if (method === 'Delivery' && o.rider) {
    const r = await q("select rid from staff where rid=$1 and role='delivery' and active", [String(o.rider)]);
    if (!r.rows[0]) throw new E('That rider is no longer available. Please choose another.');
    rider = r.rows[0].rid;
  }
  const orderId = newOrderId(), items = []; let total = 0;
  const client = await getPool().connect();
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
    await client.query('insert into orders(id,email,name,contact,address,method,items,total,note,rider,delivery_status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [orderId, email, name, contact, method === 'Delivery' ? address : 'Store pickup', method, JSON.stringify(items), total,
       String(o.note || '').slice(0, 200), rider, rider ? 'Requested' : '']);
    await client.query('commit');
  } catch (e) { await client.query('rollback').catch(() => {}); throw e; } finally { client.release(); }
  if (emailOn()) {
    const mails = ADMIN_EMAILS.map(a => tryMail(a, 'New order ' + orderId, `${name} (${contact}) - ${method} - PHP ${total}`));
    if (email) mails.push(tryMail(email, `Your order ${orderId} - ${STORE_NAME}`, `Hi ${name},\n\nThank you for your order!\nOrder ID: ${orderId}\n\n` +
      items.map(i => `- ${i.qty} x ${i.name} @ PHP ${i.price} = PHP ${i.qty * i.price}`).join('\n') +
      `\n\nTotal: PHP ${total}\n${method === 'Pickup' ? 'Pick up at: ' + STORE_NAME + ' ' + STORE_ADDRESS : 'Delivery to: ' + address}\n\nWe will email you once the store confirms your order.`));
    await Promise.all(mails);
  }
  return { orderId, total };
}
async function trackOrder(orderId, contact) {
  const d = normPhone(contact), k = idKey(orderId);
  const { rows } = await q("select * from orders where upper(regexp_replace(id,'[^A-Za-z0-9]','','g')) = $1", [k]);
  if (!k || !/^09\d{9}$/.test(d) || !rows[0] || normPhone(rows[0].contact) !== d)
    throw new E('No order found. Check the order ID and use the mobile number you ordered with (09XXXXXXXXX).');
  return orderOut(rows[0], await riderMap());
}
async function trackMany(items) {
  const list = (Array.isArray(items) ? items : []).slice(0, 40).map(i => ({ k: idKey(i.id), c: normPhone(i.contact) }));
  if (!list.length) return [];
  const { rows } = await q("select * from orders where created > now() - interval '30 days' and upper(regexp_replace(id,'[^A-Za-z0-9]','','g')) = any($1) order by created desc", [list.map(i => i.k)]);
  const rm = await riderMap();
  return rows.filter(o => list.some(i => i.k === idKey(o.id) && i.c === normPhone(o.contact))).map(o => orderOut(o, rm));
}

/* ---------- Admin + cashier ---------- */
async function adminGetOrders(token) {
  await auth(token, STORE_ROLES);
  const { rows } = await q("select * from orders where status='Pending' or created > now() - interval '7 days' order by created desc");
  const rm = await riderMap(); return rows.map(o => orderOut(o, rm));
}
async function adminPoll(token) {
  await auth(token, STORE_ROLES);
  const { rows } = await q("select id,name,total,method from orders where status='Pending'");
  return rows.map(r => ({ id: r.id, name: r.name, total: Number(r.total), method: r.method }));
}
async function adminReviewOrder(token, orderId, missingIds, adminNote) {
  await auth(token, STORE_ROLES);
  const { rows } = await q('select * from orders where id=$1', [orderId]), o = rows[0];
  if (!o) throw new E('Order not found.');
  if (o.status !== 'Pending') throw new E('This order was already reviewed.');
  const missing = o.items.filter(i => (missingIds || []).includes(i.id)), status = missing.length ? 'Incomplete' : 'Complete';
  await q('update orders set status=$1, missing=$2, admin_note=$3 where id=$4', [status, JSON.stringify(missing), String(adminNote || '').slice(0, 300), orderId]);
  let emailed = false;
  if (o.email && emailOn()) {
    const refund = missing.reduce((t, i) => t + i.price * i.qty, 0);
    let body = `Hi ${o.name},\n\nYour order ${orderId} is ${status.toUpperCase()}.\n`;
    if (missing.length) body += `\nMissing items:\n${missing.map(i => `- ${i.qty} x ${i.name}`).join('\n')}\nAmount deducted: PHP ${refund}\nNew total: PHP ${Number(o.total) - refund}\n`;
    if (adminNote) body += `\nNote from the store: ${adminNote}\n`;
    body += '\n' + (o.method === 'Pickup' ? 'Pick up at: ' + STORE_NAME + ' ' + STORE_ADDRESS : 'It will be delivered to ' + o.address + '.');
    emailed = await tryMail(o.email, `Order ${orderId}: ${status}`, body);
  }
  return { status, emailed };
}
async function adminAssignRider(token, orderId, rid) {
  await auth(token, STORE_ROLES);
  const r = await q("select rid from staff where rid=$1 and role='delivery' and active", [String(rid || '')]);
  if (!r.rows[0]) throw new E('Choose a rider.');
  const u = await q("update orders set rider=$1, delivery_status='Requested' where id=$2 and method='Delivery' and delivery_status in ('','Declined')", [rid, orderId]);
  if (!u.rowCount) throw new E('A rider cannot be assigned to this order right now.');
  return true;
}
async function adminGetProducts(token) {
  await auth(token, STORE_ROLES);
  const { rows } = await q('select * from products order by category, name');
  return rows.map(prod);
}
async function adminSaveProduct(token, p) {
  await auth(token, STORE_ROLES);
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
  await auth(token, ['admin']); // cashiers cannot delete
  const r = await q('delete from products where id=$1', [String(id)]);
  if (!r.rowCount) throw new E('Product not found (it may already be deleted).');
  return true;
}

/* ---------- Staff management (owner only) ---------- */
async function adminListStaff(token) {
  await auth(token, ['admin']);
  const { rows } = await q('select email,name,phone,role,active,last_seen from staff order by role, name');
  return rows.map(r => ({ email: r.email, name: r.name, phone: r.phone, role: r.role, active: r.active, online: r.active && Number(r.last_seen) > Date.now() - ONLINE_MS }));
}
async function adminSaveStaff(token, s) {
  await auth(token, ['admin']);
  const email = String(s.email || '').trim().toLowerCase(), name = String(s.name || '').trim(), phone = normPhone(s.phone), role = s.role;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new E('Enter a valid email address.');
  if (isOwner(email)) throw new E('That email is the owner account.');
  if (name.length < 2) throw new E('Enter the staff name.');
  if (!['cashier', 'delivery'].includes(role)) throw new E('Choose a role.');
  if (!/^09\d{9}$/.test(phone)) throw new E('Enter the mobile number as 09XXXXXXXXX.');
  const pw = String(s.password || '');
  if (pw && pw.length < 6) throw new E('Password must be at least 6 characters.');
  const ex = await q('select 1 from staff where email=$1', [email]);
  if (ex.rowCount) {
    await q('update staff set name=$1, role=$2, phone=$3, active=$4 where email=$5', [name, role, phone, s.active !== false, email]);
    if (pw) await q('update staff set pass=$1 where email=$2', [hashPw(pw), email]);
  } else {
    if (!pw) throw new E('Set a password (at least 6 characters) for new staff.');
    await q('insert into staff(email,rid,name,role,phone,pass,active) values ($1,$2,$3,$4,$5,$6,$7)',
      [email, crypto.randomBytes(4).toString('hex'), name, role, phone, hashPw(pw), s.active !== false]);
  }
  return true;
}
async function adminDeleteStaff(token, email) {
  await auth(token, ['admin']);
  await q('delete from sessions where email=$1', [String(email).toLowerCase()]);
  await q('delete from staff where email=$1', [String(email).toLowerCase()]);
  return true;
}

/* ---------- Delivery rider ---------- */
async function riderOrders(token) {
  const a = await auth(token, ['delivery']);
  const { rows } = await q("select * from orders where rider=$1 and method='Delivery' and (delivery_status in ('Requested','Accepted') or created > now() - interval '7 days') order by created desc", [a.staff.rid]);
  return rows.map(o => orderOut(o, {}));
}
async function riderPoll(token) {
  const a = await auth(token, ['delivery']);
  const { rows } = await q("select id,name,total from orders where rider=$1 and delivery_status='Requested'", [a.staff.rid]);
  return rows.map(r => ({ id: r.id, name: r.name, total: Number(r.total) }));
}
async function riderRespond(token, orderId, action) {
  const a = await auth(token, ['delivery']);
  const { rows } = await q('select * from orders where id=$1 and rider=$2', [orderId, a.staff.rid]), o = rows[0];
  if (!o) throw new E('Order not found.');
  const step = { accept: ['Requested', 'Accepted'], decline: ['Requested', 'Declined'], delivered: ['Accepted', 'Delivered'] }[action];
  if (!step || o.delivery_status !== step[0]) throw new E('This delivery cannot be changed right now.');
  await q('update orders set delivery_status=$1 where id=$2', [step[1], orderId]);
  return { deliveryStatus: step[1] };
}

const fns = { getInfo, getProducts, getRiders, placeOrder, trackOrder, trackMany, sendCode, verifyCode, loginPassword, signOut,
  adminGetOrders, adminPoll, adminReviewOrder, adminAssignRider, adminGetProducts, adminSaveProduct, adminDeleteProduct,
  adminListStaff, adminSaveStaff, adminDeleteStaff, riderOrders, riderPoll, riderRespond };

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') { // open /api/rpc in your browser to check the setup
      let db = 'ok'; try { await init(); await q('select 1'); } catch (e) { db = String(e.message).slice(0, 160); }
      return res.status(200).json({ ok: db === 'ok', database: db, settings: {
        DATABASE_URL: !!(process.env.DATABASE_URL || process.env.POSTGRES_URL), ADMIN_EMAILS: ADMIN_EMAILS.length,
        ADMIN_PASSWORD: !!process.env.ADMIN_PASSWORD, CLOUDINARY: !!(process.env.CLOUDINARY_CLOUD && process.env.CLOUDINARY_PRESET), email: emailOn() } });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    const { fn, args } = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(fns, fn)) return res.status(404).json({ error: 'Unknown function' });
    await init();
    return res.status(200).json({ result: await fns[fn](...(Array.isArray(args) ? args : [])) });
  } catch (e) {
    if (!(e instanceof E)) console.error(e);
    res.status(e instanceof E ? 400 : 500).json({ error: e instanceof E ? e.message : 'Something went wrong. Please try again.',
      detail: !(e instanceof E) && process.env.DEBUG_ERRORS ? String(e.message).slice(0, 200) : undefined });
  }
};
