require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { Pool, types } = require('pg');

types.setTypeParser(1082, (v) => v);            // DATE يرجع كنص 'YYYY-MM-DD' بدون تغيير المنطقة الزمنية
types.setTypeParser(1700, (v) => parseFloat(v));  // NUMERIC يرجع كرقم

const { DATABASE_URL, ADMIN_PASSWORD } = process.env;
if (!DATABASE_URL) { console.error('❌ DATABASE_URL غير موجود في .env'); process.exit(1); }
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) { console.error('❌ ضع ADMIN_PASSWORD (8 أحرف على الأقل) في .env'); process.exit(1); }
const ADMIN_SECRET = process.env.ADMIN_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.ADMIN_SECRET) console.warn('⚠️ ADMIN_SECRET غير موجود: سيُسجَّل خروج الأدمن عند كل إعادة تشغيل.');
const PORT = process.env.PORT || 5000;

const app = express();
app.set('trust proxy', 1);
if (process.env.CORS_ORIGIN) app.use(cors({ origin: process.env.CORS_ORIGIN }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon
  max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000
});

/* ============ الكتالوج (يجب أن يطابق الأسعار في الواجهات) ============ */
const PLANS = {
  w1: { id: 'w1', period: 'أسبوعي', meals: 1, price: 125, days: 5 },
  w2: { id: 'w2', period: 'أسبوعي', meals: 2, price: 250, days: 5 },
  m1: { id: 'm1', period: 'شهري', meals: 1, price: 500, days: 20 },
  m2: { id: 'm2', period: 'شهري', meals: 2, price: 900, days: 20 }
};
const planTitle = (p) => `اشتراك ${p.period} — ${p.meals === 1 ? 'وجبة واحدة يومياً' : 'وجبتان يومياً'}`;
const CATALOG = {};
const addDishes = (names, sizes) => names.forEach((n) => (CATALOG[n] = sizes));
addDishes(['كبسة دجاج سعودية', 'برياني'], { 'نص حبة': 35, 'حبة كاملة': 60 });
addDishes(['جريش', 'سليق', 'عصيدة تمر', 'عصيدة سكر'], { 'صغير': 50, 'وسط': 80, 'كبير': 100 });
addDishes(['صينية رز بالدجاج والكريمة', 'مكرونة حمراء', 'باشميل لحم', 'باشميل دجاج', 'باستا', 'كرات بطاطس', 'مقعقة لحم'], { 'صغير': 25, 'وسط': 70 });
addDishes(['بتر تشكن مع رز أبيض'], { 'صغير': 30, 'وسط': 70 });
addDishes(['فتة ورق عنب', 'فتة باذنجان', 'سلطة خضرا', 'فتوش', 'سلطة شمندر', 'سلطة دوريتوس', 'سلطة مقالي'], { 'صغير': 30, 'وسط': 60 });
const DISHES = new Set(Object.keys(CATALOG));
const STATUSES = ['pending', 'awaiting_payment', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'];
const PAYMENTS = ['unpaid', 'paid', 'refunded'];
const DAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس'];

/* ============ أدوات ============ */
const fail = (res, code, msg) => res.status(code).json({ error: msg });
const h = (fn) => (req, res, next) => fn(req, res, next).catch((e) => { console.error('❌', req.method, req.path, e.message); fail(res, 500, 'خطأ في الخادم، حاول مرة أخرى'); });
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const riyadhToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const toUTC = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const DAY = 86400000;
const hashPw = (pw) => { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'); };

function limit(name, max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip, now = Date.now(), rec = hits.get(key);
    if (!rec || rec.until < now) hits.set(key, { n: 1, until: now + windowMs });
    else if (++rec.n > max) return fail(res, 429, 'محاولات كثيرة، حاول لاحقاً');
    next();
  };
}

/* جلسة الأدمن: توكن موقّع بـ HMAC ينتهي بعد 12 ساعة */
const sign = (v) => crypto.createHmac('sha256', ADMIN_SECRET).update(v).digest('hex');
const makeToken = () => { const exp = String(Date.now() + 12 * 3600e3); return exp + '.' + sign(exp); };
function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const [exp, sig] = t.split('.');
  if (exp && sig && Number(exp) > Date.now()) {
    const a = Buffer.from(sig), b = Buffer.from(sign(exp));
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  }
  fail(res, 401, 'غير مصرّح');
}

/* جلسة ومصادقة المندوبين (Staff) */
const signStaff = (v) => crypto.createHmac('sha256', ADMIN_SECRET).update(v).digest('hex');
function authStaff(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const [staffId, exp, sig] = t.split('.');
  if (staffId && exp && sig && Number(exp) > Date.now()) {
    const payload = staffId + '.' + exp;
    const expectedSig = signStaff(payload);
    const a = Buffer.from(sig), b = Buffer.from(expectedSig);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      req.staffId = staffId;
      return next();
    }
  }
  fail(res, 401, 'غير مصرّح للمندوب');
}

const strip = (r) => { const { access_token, ...rest } = r; return rest; };
async function getPayment() {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'payment'");
  return rows[0] ? rows[0].value : {};
}
const ORDER_WITH_DRIVER = 'SELECT o.*, s.full_name AS driver_name FROM orders o LEFT JOIN staff s ON s.id = o.driver_id';

/* ============ قاعدة البيانات ============ */
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        client_name VARCHAR(255) NOT NULL,
        client_phone VARCHAR(50) NOT NULL,
        order_type VARCHAR(20) NOT NULL,
        service_title VARCHAR(255) NOT NULL,
        plan_id VARCHAR(20) DEFAULT '',
        meals INT DEFAULT 0,
        items JSONB DEFAULT '[]'::jsonb,
        booking_date DATE NOT NULL,
        booking_time VARCHAR(60) NOT NULL,
        location_address TEXT DEFAULT '',
        latitude NUMERIC(10,7),
        longitude NUMERIC(10,7),
        service_price NUMERIC(10,2) NOT NULL DEFAULT 0,
        status VARCHAR(30) DEFAULT 'pending',
        payment_status VARCHAR(20) DEFAULT 'unpaid',
        driver_id TEXT DEFAULT '',
        invoice_sent_at TIMESTAMPTZ,
        meal_plan JSONB,
        pending_meal_plan JSONB,
        meal_status VARCHAR(20) DEFAULT 'none',
        meal_requested_at TIMESTAMPTZ,
        meal_approved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_orders_date ON orders (booking_date);
      CREATE TABLE IF NOT EXISTS staff (
        id TEXT PRIMARY KEY,
        role VARCHAR(20) DEFAULT 'driver',
        full_name VARCHAR(255) NOT NULL,
        phone VARCHAR(50) NOT NULL,
        password_hash TEXT NOT NULL,
        photo_url TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL
      );
    `);
    console.log('✅ Connected to Neon PostgreSQL — tables verified.');
  } finally { client.release(); }
}

/* ============ API العملاء ============ */
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.post('/api/orders', limit('orders', 20, 3600e3), h(async (req, res) => {
  const b = req.body || {};
  const name = String(b.client_name || '').trim().slice(0, 100), phone = String(b.client_phone || '').trim();
  if (!name) return fail(res, 400, 'يرجى كتابة الاسم');
  if (!/^05\d{8}$/.test(phone)) return fail(res, 400, 'رقم الجوال غير صحيح');
  const date = String(b.booking_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(toUTC(date)) || toUTC(date) < toUTC(riyadhToday())) return fail(res, 400, 'تاريخ التوصيل غير صحيح');
  const time = String(b.booking_time || '').trim().slice(0, 60);
  if (!time) return fail(res, 400, 'يرجى اختيار وقت التوصيل');
  const lat = Number(b.latitude), lng = Number(b.longitude);
  if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) || b.latitude == null) return fail(res, 400, 'يرجى تحديد موقع التوصيل');

  let title, price = 0, items = [], planId = '', meals = 0;
  const type = b.order_type;
  if (type === 'subscription') {
    const p = PLANS[b.plan_id];
    if (!p) return fail(res, 400, 'الاشتراك غير موجود');
    title = planTitle(p); price = p.price; planId = p.id; meals = p.meals;
  } else if (type === 'menu') {
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 30) return fail(res, 400, 'أضف طبقاً واحداً على الأقل');
    for (const it of b.items) {
      const unit = CATALOG[it && it.name] && CATALOG[it.name][it.size], qty = Number(it && it.qty);
      if (!unit || !Number.isInteger(qty) || qty < 1 || qty > 20) return fail(res, 400, 'طبق أو حجم غير صحيح');
      price += unit * qty; items.push({ name: it.name, size: it.size, qty, price: unit });
    }
    title = 'طلب من القائمة';
  } else return fail(res, 400, 'نوع الطلب غير صحيح');

  const address = 'موقع التوصيل | https://www.google.com/maps?q=' + lat.toFixed(5) + ',' + lng.toFixed(5);
  const token = crypto.randomBytes(16).toString('hex');
  for (let i = 0; i < 5; i++) {
    const id = 'SFR-' + crypto.randomInt(100000, 999999);
    try {
      const { rows } = await pool.query(
        `INSERT INTO orders (id, access_token, client_name, client_phone, order_type, service_title, plan_id, meals, items,
            booking_date, booking_time, location_address, latitude, longitude, service_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [id, sha(token), name, phone, type, title, planId, meals, JSON.stringify(items), date, time, address, lat, lng, price]);
      return res.status(201).json({ order: strip(rows[0]), token });
    } catch (e) { if (e.code !== '23505') throw e; }
  }
  fail(res, 500, 'تعذر إنشاء رقم الطلب، حاول مرة أخرى');
}));

app.post('/api/my/orders', limit('my', 120, 60e3), h(async (req, res) => {
  const refs = (Array.isArray(req.body && req.body.orders) ? req.body.orders : []).slice(0, 30)
    .filter((r) => r && typeof r.id === 'string' && typeof r.token === 'string');
  if (!refs.length) return res.json([]);
  const { rows } = await pool.query(
    `${ORDER_WITH_DRIVER} WHERE (o.id, o.access_token) IN (SELECT * FROM unnest($1::text[], $2::text[])) ORDER BY o.created_at DESC`,
    [refs.map((r) => r.id), refs.map((r) => sha(r.token))]);
  const pay = rows.some((r) => r.status === 'awaiting_payment') ? await getPayment() : null;
  res.json(rows.map((r) => {
    const o = strip(r); delete o.latitude; delete o.longitude;
    if (r.status === 'awaiting_payment' && pay && pay.iban) o.payment_info = { bank: pay.bank, holder: pay.holder, iban: pay.iban };
    return o;
  }));
}));

function validPlan(plan, meals) {
  if (!plan || typeof plan !== 'object') return null;
  const out = {};
  for (const d of ['0', '1', '2', '3', '4']) {
    if (plan[d] === undefined) continue;
    const a = plan[d];
    if (!Array.isArray(a) || a.length !== meals || !a.every((n) => typeof n === 'string' && DISHES.has(n))) return null;
    out[d] = a;
  }
  return Object.keys(out).length ? out : null;
}

function canEditDay(order, d) {
  const today = toUTC(riyadhToday()), base = Math.max(toUTC(order.booking_date), today);
  const next = base + ((d - new Date(base).getUTCDay() + 7) % 7) * DAY;
  return (next - today) / DAY >= 1;
}

app.post('/api/my/orders/:id/meals', limit('meals', 60, 3600e3), h(async (req, res) => {
  const token = String((req.body && req.body.token) || '');
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1 AND access_token = $2', [req.params.id, sha(token)]);
  const o = rows[0];
  if (!o) return fail(res, 404, 'الطلب غير موجود');
  if (o.order_type !== 'subscription' || o.status === 'cancelled') return fail(res, 400, 'لا يمكن تعديل أطباق هذا الطلب');
  const plan = validPlan(req.body.plan, o.meals || 1);
  if (!plan) return fail(res, 400, 'اختيار الأطباق غير صحيح');
  const current = o.pending_meal_plan || o.meal_plan || {};
  for (const d of Object.keys(plan)) {
    if (JSON.stringify(plan[d]) !== JSON.stringify(current[d]) && !canEditDay(o, Number(d)))
      return fail(res, 403, `يوم ${DAY_NAMES[d]} مقفل للتعديل (أقل من يوم على موعده)`);
  }
  const merged = { ...current, ...plan };
  const upd = await pool.query(
    `UPDATE orders SET pending_meal_plan = $1, meal_status = 'pending', meal_requested_at = now() WHERE id = $2 RETURNING *`,
    [JSON.stringify(merged), o.id]);
  const full = await pool.query(`${ORDER_WITH_DRIVER} WHERE o.id = $1`, [upd.rows[0].id]);
  const out = strip(full.rows[0]); delete out.latitude; delete out.longitude;
  res.json(out);
}));

/* ============ API المندوبين (Staff) ============ */
app.post('/api/staff/login', limit('staff_login', 10, 15 * 60e3), h(async (req, res) => {
  const { phone, password } = req.body || {};
  const cleanPhone = String(phone || '').trim();
  const cleanPw = String(password || '');
  if (!cleanPhone || !cleanPw) return fail(res, 400, 'يرجى إدخال الجوال وكلمة المرور');

  const { rows } = await pool.query('SELECT * FROM staff WHERE phone = $1', [cleanPhone]);
  const staff = rows[0];
  if (!staff) return fail(res, 401, 'رقم الجوال أو كلمة المرور غير صحيحة');

  const [salt, key] = staff.password_hash.split(':');
  const hash = crypto.scryptSync(cleanPw, salt, 64).toString('hex');
  if (!crypto.timingSafeEqual(Buffer.from(key), Buffer.from(hash))) {
    return fail(res, 401, 'رقم الجوال أو كلمة المرور غير صحيحة');
  }

  const exp = String(Date.now() + 24 * 3600e3);
  const payload = staff.id + '.' + exp;
  const token = payload + '.' + signStaff(payload);

  res.json({
    token,
    staff: { id: staff.id, full_name: staff.full_name, phone: staff.phone, photo_url: staff.photo_url }
  });
}));

app.get('/api/staff/orders', authStaff, h(async (req, res) => {
  const { rows } = await pool.query(
    `${ORDER_WITH_DRIVER} WHERE o.driver_id = $1 ORDER BY o.booking_date DESC LIMIT 200`,
    [req.staffId]
  );
  res.json(rows.map(strip));
}));

app.patch('/api/staff/orders/:id', authStaff, h(async (req, res) => {
  const check = await pool.query('SELECT driver_id FROM orders WHERE id = $1', [req.params.id]);
  if (!check.rows[0] || check.rows[0].driver_id !== req.staffId) {
    return fail(res, 403, 'غير مصرح لك بتعديل هذا الطلب');
  }

  const b = req.body || {};
  const newStatus = b.status;
  const allowed = ['out_for_delivery', 'delivered'];
  if (!allowed.includes(newStatus)) {
    return fail(res, 400, 'حالة غير مسموح بتعديلها');
  }

  const { rows } = await pool.query(
    'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
    [newStatus, req.params.id]
  );
  const full = await pool.query(`${ORDER_WITH_DRIVER} WHERE o.id = $1`, [rows[0].id]);
  res.json(strip(full.rows[0]));
}));

/* ============ API الأدمن ============ */
app.post('/api/admin/login', limit('login', 10, 15 * 60e3), (req, res) => {
  const a = crypto.createHash('sha256').update(String((req.body && req.body.password) || '')).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) return fail(res, 401, 'كلمة المرور غير صحيحة');
  res.json({ token: makeToken() });
});

app.get('/api/admin/orders', auth, h(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 3000');
  res.json(rows.map(strip));
}));

app.patch('/api/admin/orders/:id', auth, h(async (req, res) => {
  const b = req.body || {}, sets = [], vals = [];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (b.status !== undefined) { if (!STATUSES.includes(b.status)) return fail(res, 400, 'حالة غير صحيحة'); add('status', b.status); }
  if (b.payment_status !== undefined) { if (!PAYMENTS.includes(b.payment_status)) return fail(res, 400, 'حالة دفع غير صحيحة'); add('payment_status', b.payment_status); }
  if (b.driver_id !== undefined) {
    const id = String(b.driver_id || '');
    if (id && !(await pool.query('SELECT 1 FROM staff WHERE id = $1', [id])).rowCount) return fail(res, 400, 'المندوب غير موجود');
    add('driver_id', id);
  }
  if (b.invoice_sent) sets.push('invoice_sent_at = now()');
  if (!sets.length) return fail(res, 400, 'لا توجد تعديلات');
  vals.push(req.params.id);
  const { rows } = await pool.query(`UPDATE orders SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
  if (!rows[0]) return fail(res, 404, 'الطلب غير موجود');
  res.json(strip(rows[0]));
}));

app.post('/api/admin/orders/:id/accept-meals', auth, h(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE orders SET meal_plan = pending_meal_plan, pending_meal_plan = NULL, meal_status = 'approved', meal_approved_at = now()
     WHERE id = $1 AND meal_status = 'pending' AND pending_meal_plan IS NOT NULL RETURNING *`, [req.params.id]);
  if (!rows[0]) return fail(res, 404, 'لا يوجد طلب أطباق معلّق لهذا الطلب');
  res.json(strip(rows[0]));
}));

app.delete('/api/admin/orders/:id', auth, h(async (req, res) => {
  const r = await pool.query('DELETE FROM orders WHERE id = $1', [req.params.id]);
  if (!r.rowCount) return fail(res, 404, 'الطلب غير موجود');
  res.json({ ok: true });
}));

app.get('/api/admin/staff', auth, h(async (req, res) => {
  const { rows } = await pool.query('SELECT id, role, full_name, phone, photo_url, created_at FROM staff ORDER BY created_at');
  res.json(rows);
}));

app.post('/api/admin/staff', auth, h(async (req, res) => {
  const b = req.body || {};
  const name = String(b.full_name || '').trim().slice(0, 100), phone = String(b.phone || '').trim(), pw = String(b.password || '');
  if (!name) return fail(res, 400, 'يرجى كتابة الاسم');
  if (!/^\+?\d{9,15}$/.test(phone)) return fail(res, 400, 'رقم الجوال غير صحيح');
  if (pw.length < 6) return fail(res, 400, 'كلمة المرور 6 أحرف على الأقل');
  const photo = String(b.photo_url || '');
  if (photo && (!photo.startsWith('data:image/') || photo.length > 300000)) return fail(res, 400, 'الصورة غير صالحة أو كبيرة');
  const id = 'st_' + crypto.randomBytes(6).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO staff (id, role, full_name, phone, password_hash, photo_url) VALUES ($1,'driver',$2,$3,$4,$5)
     RETURNING id, role, full_name, phone, photo_url, created_at`, [id, name, phone, hashPw(pw), photo]);
  res.status(201).json(rows[0]);
}));

app.delete('/api/admin/staff/:id', auth, h(async (req, res) => {
  await pool.query("UPDATE orders SET driver_id = '' WHERE driver_id = $1", [req.params.id]);
  const r = await pool.query('DELETE FROM staff WHERE id = $1', [req.params.id]);
  if (!r.rowCount) return fail(res, 404, 'المندوب غير موجود');
  res.json({ ok: true });
}));

app.get('/api/admin/settings', auth, h(async (req, res) => res.json(await getPayment())));

app.put('/api/admin/settings', auth, h(async (req, res) => {
  const b = req.body || {}, iban = String(b.iban || '').replace(/\s+/g, '').toUpperCase();
  if (!/^SA\d{22}$/.test(iban)) return fail(res, 400, 'الآيبان السعودي يبدأ بـ SA ويتبعه 22 رقماً');
  const value = { bank: String(b.bank || '').trim().slice(0, 80), holder: String(b.holder || '').trim().slice(0, 120), iban, note: String(b.note || '').trim().slice(0, 300) };
  await pool.query(`INSERT INTO settings (key, value) VALUES ('payment', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(value)]);
  res.json(value);
}));

/* ============ الصفحات ============ */
app.use('/api', (req, res) => fail(res, 404, 'المسار غير موجود'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/staff', (req, res) => res.sendFile(path.join(__dirname, 'public', 'staff.html')));
app.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, req, res, next) => fail(res, 400, 'طلب غير صالح'));

initializeDatabase()
  .catch((e) => console.error('❌ Error initializing database:', e.message))
  .finally(() => app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server listening on port ${PORT}`)));