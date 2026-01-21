// ===============================
// Phoenix Clinic - Backend Server
// ===============================
console.log('RUN:', __filename);
console.log('PWD:', process.cwd());

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');
// ===== Booking Bot Account (Dedicated) =====
const BOOKING_ACCOUNT = {
  user: process.env.BOOKING_USER,
  pass: process.env.BOOKING_PASS
};

const INSTANCE_ID  = process.env.INSTANCE_ID;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const SKIP_OTP_FOR_TESTING = process.env.SKIP_OTP_FOR_TESTING === 'true';
const BASE_DL_DIR =
  process.env.PUPPETEER_DOWNLOAD_PATH ||
  process.env.PUPPETEER_CACHE_DIR ||
  '/app/.cache/puppeteer';

const CHROMIUM_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  process.env.CHROME_PATH ||
  null;
/* ================= Redis ================= */
const redis = new Redis(process.env.REDIS_URL, {
  retryStrategy(times) {
    return Math.min(times * 100, 2000);
  }
});


/* ================= WATCH ================= */
const WATCH = process.env.WATCH === '1' || process.env.DEBUG_BROWSER === '1';

redis.on('connect', () => console.log('🟢 Redis connected'));
redis.on('error', e => console.error('🔴 Redis error', e.message));

/* ================= Login Cache (Redis – 24h) ================= */
async function getLoginCache(identityDigits) {
  const v = await redis.get(`login:${identityDigits}`);
  return v ? JSON.parse(v) : null;
}

async function setLoginCache(identityDigits, data) {
  await redis.set(
    `login:${identityDigits}`,
    JSON.stringify(data)
  );
}

async function getTimesCache(key) {
  const v = await redis.get(`times:${key}`);
  return v ? JSON.parse(v) : null;
}


/* ================= Times Cache (Redis – 3 min) ================= */
/* ================= Slot Lock (Immediate) ================= */
const SLOT_LOCK_TTL_SEC = 15 * 60; // 15 دقيقة

function slotLockKey(clinic, date, time) {
  // ⬅️ للتشقير: نقفل الساعة كاملة
  const hour = String(time || '').split(':')[0];
  return `lock:slot:${clinic}:${date}:${hour}:00`;
}


async function lockSlot(clinic, date, time, by) {
  const key = slotLockKey(clinic, date, time);
  const ok = await redis.set(
    key,
    JSON.stringify({ by, ts: Date.now() }),
    'NX',
    'EX',
    SLOT_LOCK_TTL_SEC
  );
  return !!ok; // true إذا تم القفل
}

async function unlockSlot(clinic, date, time) {
  const key = slotLockKey(clinic, date, time);
  await redis.del(key);
}

async function isSlotLocked(clinic, date, time) {
  const key = slotLockKey(clinic, date, time);
  return !!(await redis.get(key));
}

async function setTimesCache(key, data) {
  await redis.set(
    `times:${key}`,
    JSON.stringify(data),
    'EX',
    3 * 60   // ⬅️ هنا 3 دقائق
  );
}
function clinicCacheKey(clinicStr) {
  return PREFETCH_KEY_PREFIX + normalizeClinicKey(clinicStr);
}


async function getClinicTimesFromRedis(clinicStr) {
  const v = await redis.get(clinicCacheKey(clinicStr));
  return v ? JSON.parse(v) : null;
}

async function setClinicTimesToRedis(clinicStr, times) {
  await redis.set(
    clinicCacheKey(clinicStr),
    JSON.stringify({ ts: Date.now(), times: times || [] }),
    'EX',
    PREFETCH_TTL_SEC
  );
}

/* ================= Prefetch Cache (All Clinics) ================= */
const PREFETCH_TTL_SEC = Number(process.env.PREFETCH_TTL_SEC || 180); // 3 دقائق
const PREFETCH_KEY_PREFIX = 'prefetch_times_v1:';
const PREFETCH_LOCK_KEY = 'prefetch_times_lock_v1';
const PREFETCH_LOCK_SEC = 120;


const timesInFlight = new Map();

function makeTimesKey({ clinic, month, period }) {
  return `${String(clinic||'').trim()}|${String(month||'').trim()}|${String(period||'').trim()}`;
}

/* ================= Booking Auth Cache (in-memory – 15 min) ================= */
const BOOKING_TTL_MS = 15 * 60 * 1000;
const bookingAuthCache = new Map();

function setBookingAuth(identityDigits, fileId) {
  bookingAuthCache.set(identityDigits, {
    fileId,
    exp: Date.now() + BOOKING_TTL_MS
  });
}

function getBookingAuth(identityDigits) {
  const rec = bookingAuthCache.get(identityDigits);
  if (!rec) return null;
  if (Date.now() > rec.exp) {
    bookingAuthCache.delete(identityDigits);
    return null;
  }
  return rec;
}

/* ================= Puppeteer Environment ================= */
process.env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || '/tmp';
process.env.LANG = process.env.LANG || 'ar_SA.UTF-8';
process.env.PUPPETEER_CACHE_DIR = path.join(__dirname, '.puppeteer_cache');

/* ================= Shared Browser ================= */
let sharedBrowser = null;

async function getSharedBrowser() {
  if (sharedBrowser) return sharedBrowser;
  sharedBrowser = await launchBrowserSafe();
  return sharedBrowser;
}

async function resetSharedBrowser() {
  try { if (sharedBrowser) await sharedBrowser.close(); } catch {}
  sharedBrowser = null;
}
/* ================= Prefetch All Clinics Times ================= */
async function prefetchAllClinicsTimes() {

  // 🔒 Lock لمنع تشغيل متوازي
  const locked = await redis.set(
    PREFETCH_LOCK_KEY,
    '1',
    'NX',
    'EX',
    PREFETCH_LOCK_SEC
  );

  if (!locked) {
    console.log('[PREFETCH] already running, skip');
    return;
  }

  console.log('[PREFETCH] start fetching all clinics');

  try {
    for (const clinic of CLINICS_LIST) {
      try {
        console.log('[PREFETCH] clinic:', clinic);

        // نستخدم نفس منطق /api/times لكن بدون month من المستخدم
        const times = await fetchTimesForClinic30Days(clinic);

      if (Array.isArray(times)) {
  await setClinicTimesToRedis(clinic, times);
}


      } catch (e) {
        console.error('[PREFETCH] clinic failed:', clinic, e?.message);
      }
    }
  } finally {
    await redis.del(PREFETCH_LOCK_KEY);
    console.log('[PREFETCH] done');
  }
}

/* ================= Express ================= */
const app = express();

/* 🔁 تحويل الدومين بدون www إلى www (أول شيء) */
app.use((req, res, next) => {
  if (req.headers.host === 'phoenixclinic.net') {
    return res.redirect(301, 'https://www.phoenixclinic.net' + req.url);
  }
  next();
});

/* Static files */
app.use(express.static(path.join(__dirname)));
// ✅ دعم المسارات العربية (SEO Slugs)
app.get('/:slug', (req, res, next) => {
  try {
    const slug = decodeURIComponent(req.params.slug);

    if (slug === 'حجز-موعد') {
      return res.sendFile(path.join(__dirname, 'appointment.html'));
    }

    if (slug === 'الرئيسية') {
      return res.sendFile(path.join(__dirname, 'index.html'));
    }

    if (slug === 'من-نحن') {
      return res.sendFile(path.join(__dirname, 'about.html'));
    }

    return next();
  } catch (e) {
    return next();
  }
});



app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));
app.use((err, req, res, next) => {
  if (err?.type === 'entity.aborted') {
    console.warn('⚠️ Request aborted by client');
    return;
  }
  next(err);
});


/* الصفحة الرئيسية */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});


/* ================= Imdad Accounts Pool ================= */
const ACCOUNTS = [
  { user: "3333333333", pass: "3333333333", busy: false },
  { user: "5555555555", pass: "5555555555", busy: false },
  
];
const CLINICS_LIST = [
  "عيادة الاسنان 5 (NO.103)**الفترة الثانية",
  "عيادة الاسنان 1 (NO.100)**الفترة الاولى",
  "عيادة الاسنان 1 (NO.100)**الفترة الثانية",
  "عيادة الاسنان 2 (NO.101)**الفترة الاولى",
  "عيادة الاسنان 2 (NO.101)**الفترة الثانية",
  "عيادة الجلدية والتجميل (NO.200)**الفترة الثانية",
  "تشقير وتنظيف البشرة**الفترة الثانية",
  "النساء و الولادة (NO.400)**الفترة الاولى",
  "النساء و الولادة (NO.400)**الفترة الثانية",
  "عيادة الاسنان 6 (زراعه اسنان)**الفترة الثانية",
  "النساء و الولادة 2**الفترة الاولى",
  "النساء و الولادة 2**الفترة الثانية",
];
// ================= CLINICS CONFIG =================
const CLINIC_RULES = {
  dental_1: {
    match: /عيادة الاسنان 1/,
    morning: { from: 9*60, to: 10*60+30 },
    evening: { from: 16*60, to: 20*60+30 },
    allowFriday: false,
    allowSaturday: true
  },
  dental_2: {
    match: /عيادة الاسنان 2/,
    morning: { from: 9*60, to: 10*60+30 },
    evening: { from: 16*60, to: 20*60+30 },
    allowFriday: false,
    allowSaturday: true
  },
  dental_5: {
    match: /عيادة الاسنان 5/,
    evening: { from: 14*60, to: 21*60+30 },
    allowFriday: true,
    allowSaturday: true
  },
  dental_6: {
    match: /عيادة الاسنان 6/,
    evening: { from: 14*60, to: 21*60+30 },
    allowFriday: false,
    allowSaturday: true
  },
  derm: {
    match: /الجلدية والتجميل/,
    evening: { from: 15*60, to: 21*60+30 },
    allowFriday: false,
    allowSaturday: false
  },
  cleaning: {
    match: /تشقير|تنظيف/,
    evening: { from: 14*60, to: 22*60 },
    allowFriday: false,
    allowSaturday: true,
    hourlyOnly: true
  },
  obgyn: {
    match: /النساء و الولادة(?! 2)/,
    morning: { from: 9*60, to: 10*60+30 },
    evening: { from: 14*60, to: 21*60+30 },
    allowFriday: false,
    allowSaturday: true
  },
  obgyn2: {
    match: /النساء و الولادة 2/,
    morning: { from: 9*60, to: 10*60+30 },
    evening: { from: 14*60, to: 21*60+30 },
    allowFriday: false,
    allowSaturday: true
  }
};

// ===== Booking Queue (single worker) =====
const bookingQueue = [];
let processingBooking = false;

// ===== Login Queue =====
const loginQueue = [];
let activeLogins = 0;
const MAX_LOGIN_WORKERS = ACCOUNTS.length; // عدد حسابات إمداد


const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function acquireAccount() {
  while (true) {
    const i = ACCOUNTS.findIndex(a => !a.busy);
    if (i !== -1) {
      ACCOUNTS[i].busy = true;
      return ACCOUNTS[i];
    }
    await sleep(200);
  }
}

async function acquireAccountWithTimeout(ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const i = ACCOUNTS.findIndex(a => !a.busy);
    if (i !== -1) {
      ACCOUNTS[i].busy = true;
      return ACCOUNTS[i];
    }
    await sleep(150);
  }
  throw new Error('imdad_busy');
}

function releaseAccount(acc) {
  const i = ACCOUNTS.findIndex(a => a.user === acc.user);
  if (i !== -1) ACCOUNTS[i].busy = false;
}


// helpers accounts
async function acquireAccount() {
  while (true) {
    const i = ACCOUNTS.findIndex(a => !a.busy);
    if (i !== -1) { ACCOUNTS[i].busy = true; return ACCOUNTS[i]; }
    await sleep(200);
  }
}
async function acquireAccountWithTimeout(ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const i = ACCOUNTS.findIndex(a => !a.busy);
    if (i !== -1) { ACCOUNTS[i].busy = true; return ACCOUNTS[i]; }
    await sleep(150);
  }
  throw new Error('imdad_busy');
}
function releaseAccount(a) {
  const i = ACCOUNTS.findIndex(x => x.user === a.user);
  if (i !== -1) ACCOUNTS[i].busy = false;
}

/** ===== Helpers ===== */
function normalizeArabic(s=''){ return (s||'').replace(/\s+/g,' ').trim(); }
function toAsciiDigits(s='') {
  const map = {'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'};
  return String(s).replace(/[٠-٩]/g, d => map[d] || d);
}
function normalizeClinicKey(clinic) {
  return String(clinic || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSaudi05(v){ const d = toAsciiDigits(v||'').replace(/\D/g,''); return /^05\d{8}$/.test(d); }
function normalizePhoneIntl(v){
  const raw = toAsciiDigits(v||''); const d = raw.replace(/\D/g,'');
  if(/^05\d{8}$/.test(d)) return '966'+d.slice(1);
  if(/^5\d{8}$/.test(d)) return '966'+d;
  if(/^9665\d{8}$/.test(d)) return d;
  return d;
}
function toLocal05(v=''){
  const raw = toAsciiDigits(v||''); const d = raw.replace(/\D/g,'');
  if(/^9665\d{8}$/.test(d)) return '0'+d.slice(3);
  if(/^5\d{8}$/.test(d)) return '0'+d;
  if(/^05\d{8}$/.test(d)) return d;
  return d;
}
function phonesEqual05(a,b){
  const A = toLocal05(a||'').replace(/\D/g,''); const B = toLocal05(b||'').replace(/\D/g,'');
  return A && B && A === B;
}
function extractFileId(str=''){ const m = toAsciiDigits(str).match(/\b(\d{3,})\b/); return m ? m[1] : ''; }
function tokenizeName(n=''){ return normalizeArabic(n).split(' ').filter(Boolean); }
function nameSimilar(target='', candidate=''){
  const t = new Set(tokenizeName(target));
  const c = new Set(tokenizeName(candidate));
  if(!t.size || !c.size) return false;
  if ([...t].every(w => c.has(w))) return true;
  let common=0;
  for (const w of t) if (c.has(w)) common++;
  return common >= Math.min(2, t.size);
}
function parseSuggestionText(txt=''){
  const raw = normalizeArabic(txt);
  const parts = raw.split('*').map(s=>normalizeArabic(s));
  const tokens = parts.length > 1 ? parts : raw.split(/[-|،,]+/).map(s=>normalizeArabic(s));
  let name='', phone='', fileId='';
  for(const t of tokens){
    const td = toAsciiDigits(t); const digits = td.replace(/\D/g,'');
    if(/^05\d{8}$/.test(digits) || /^9665\d{8}$/.test(digits) || /^5\d{8}$/.test(digits)){ if(!phone) phone = digits; continue; }
    if(/\d{3,}/.test(digits) && !/^0?5\d{8}$/.test(digits) && !/^9665\d{8}$/.test(digits)){ if(!fileId) fileId = digits; continue; }
  }
  if(!name){
    const namePieces = tokens.filter(t=>{
      const td = toAsciiDigits(t); const digits = td.replace(/\D/g,'');
      if(!t) return false;
      if(/^05\d{8}$/.test(digits)) return false;
      if(/^9665\d{8}$/.test(digits)) return false;
      if(/^5\d{8}$/.test(digits)) return false;
      if(/\d{3,}/.test(digits)) return false;
      return true;
    });
    name = normalizeArabic(namePieces.join(' '));
  }
  if(phone){ phone = toLocal05(phone); }
  return { name, phone, fileId, raw: raw };
}
function isLikelyIdentity(v){
  const d = toAsciiDigits(v||'').replace(/\D/g,'');
  return d.length >= 8 && !/^05\d{8}$/.test(d);
}

/** ===== Puppeteer launch (Headful-aware, invisible window) ===== */
function launchOpts() {
  const exe = CHROMIUM_PATH || undefined;
  const headful = !!WATCH; // WATCH=1 يجعل النافذة مرئية أمامك
  const isWin = process.platform === 'win32';

  const baseArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--lang=ar-SA,ar,en-US,en',
  ];

  if (headful) {
    // 👀 وضع مراقبة: افتح المتصفح طبيعي لرؤية البوت
    baseArgs.push('--start-maximized');
  } else {
    // 🤫 الوضع المخفي: مرئي فعليًا لكن النافذة خارج الشاشة
    if (!isWin) {
      baseArgs.push('--no-zygote', '--single-process');
    }

    baseArgs.push(
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--use-gl=swiftshader',
      '--use-angle=swiftshader',
      '--window-size=1280,900',
      '--window-position=-10000,0', // 👈 يخفي النافذة فعليًا
      '--mute-audio',
      '--disable-features=IsolateOrigins,site-per-process,VizDisplayCompositor,Translate,BackForwardCache,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion,AcceptCHFrame'
    );
  }

  return {
    headless: "new", // 👈 ضروري جدًا لتعمل fillSearch120 بشكل طبيعي
    executablePath: exe,
    args: baseArgs,
    defaultViewport: { width: 1280, height: 900 },
  };
}


async function launchBrowserSafe() {
  try {
    return await puppeteer.launch(launchOpts());
  } catch (e) {
    try {
      // Fallback للـ headless-shell عند الحاجة
      const root = path.join(BASE_DL_DIR || '/app/.cache/puppeteer', 'chrome-headless-shell');
      let shell = null;
      if (fs.existsSync(root)) {
        const rels = fs.readdirSync(root).filter(n=>n.startsWith('linux-')).sort((a,b)=>b.localeCompare(a));
        for (const r of rels) {
          const p = path.join(root, r, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
          if (fs.existsSync(p)) { shell = p; break; }
        }
      }
      if (!shell) throw e;
      const opt = launchOpts();
      opt.executablePath = shell;
      return await puppeteer.launch(opt);
    } catch (e2) { throw e2; }
  }
}

async function prepPage(page){
  if (!WATCH) await page.setViewport({ width: 1280, height: 900 });
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(120000);
  await page.setExtraHTTPHeaders({ 'Accept-Language':'ar-SA,ar;q=0.9,en;q=0.8' });
  await page.emulateTimezone('Asia/Riyadh').catch(()=>{});
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit(537.36) (KHTML, like Gecko) Chrome/120 Safari/537.36');
  if (typeof page.waitForTimeout !== 'function') {
    page.waitForTimeout = (ms) => new Promise(res => setTimeout(res, ms));
  }
}

/** ===== Login / Nav (no waitForNavigation) ===== */
async function loginToImdad(page, { user, pass }) {
  console.log('[IMDAD] opening login…');

  await page.goto('https://phoenix.imdad.cloud/medica13/login.php?a=1', {
    waitUntil: 'domcontentloaded',
    timeout: 90000
  });

  await page.waitForSelector('input[name="username"]', { timeout: 30000 });
  await page.$eval('input[name="username"]', (el, v) => { el.value = v; }, user);
  await page.$eval('input[name="password"]', (el, v) => { el.value = v; }, pass);

  await page.click('#submit');

  const ok = await Promise.race([
    page.waitForSelector('#navbar-search-input', { timeout: 60000 }).then(() => true).catch(() => false),
    page.waitForSelector('a[href*="appoint_display.php"]', { timeout: 60000 }).then(() => true).catch(() => false),
    page.waitForFunction(() => /home2\.php|appoint_display\.php|main\.php/i.test(location.href), { timeout: 60000 }).then(() => true).catch(() => false),
  ]);

  if (!ok) {
    console.warn('[IMDAD] login retry…');
    await page.goto('https://phoenix.imdad.cloud/medica13/login.php?a=1', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForSelector('input[name="username"]', { timeout: 30000 });
    await page.$eval('input[name="username"]', (el, v) => { el.value = v; }, user);
    await page.$eval('input[name="password"]', (el, v) => { el.value = v; }, pass);
    await page.click('#submit');

    const ok2 = await Promise.race([
      page.waitForSelector('#navbar-search-input', { timeout: 60000 }).then(() => true).catch(() => false),
      page.waitForSelector('a[href*="appoint_display.php"]', { timeout: 60000 }).then(() => true).catch(() => false),
      page.waitForFunction(() => /home2\.php|appoint_display\.php|main\.php/i.test(location.href), { timeout: 60000 }).then(() => true).catch(() => false),
    ]);
    if (!ok2) throw new Error('login_failed');
  }

  console.log('[IMDAD] logged in.');
}
async function gotoAppointments(page){
  console.log('[IMDAD] goto appointments…');
  await page.goto('https://phoenix.imdad.cloud/medica13/appoint_display.php', {
    waitUntil:'domcontentloaded',
    timeout: 90000
  });
  await page.waitForSelector('#clinic_id', { timeout: 20000 }).catch(()=>{});
}

/** ===== Typing / Suggestions ===== */
async function typeSlow(page, selector, text, perCharDelay = 140) {
  await page.waitForSelector(selector, { visible: true, timeout: 30000 });
  await page.focus(selector);
  await page.$eval(selector, el => { el.value = ''; });
  for (const ch of text) await page.type(selector, ch, { delay: perCharDelay });
  await page.evaluate((sel)=>{
    const el = document.querySelector(sel);
    if(!el) return;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
  }, selector);
}
async function readNameSuggestions(page){
  return await page.evaluate(()=>{
    const lis = Array.from(document.querySelectorAll('li[onclick^="fillSearch12"]'));
    return lis.map((li,idx)=>({ idx, text:(li.innerText||'').trim() }));
  });
}
async function readApptSuggestions(page){
  return await page.evaluate(()=>{
    const lis = Array.from(document.querySelectorAll('li[onclick^="fillSearch120"], .searchsugg120 li'));
    return lis.map((li,idx)=>({ idx, text:(li.innerText||'').trim() }));
  });
}
async function pickFirstSuggestionOnAppointments(page, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() < start + timeoutMs) {
    const ok = await page.evaluate(() => {
      const li = document.querySelector('li[onclick^="fillSearch120"], .searchsugg120 li');
      if (li) { li.click(); return true; }
      return false;
    });
    if (ok) return true;
    await page.evaluate(() => {
      const el = document.querySelector('#SearchBox120');
      if (el) {
        ['input','keyup','keydown','change'].forEach(ev => el.dispatchEvent(new Event(ev, {bubbles:true})));
        try { if (typeof window.suggestme120 === 'function') window.suggestme120(el.value, new KeyboardEvent('keyup')); } catch(_) {}
      }
    });
    await sleep(300);
  }
  return false;
}
async function pickPatientByIdentityOrPhone(page, { identity, phone }) {
  const idDigits = String(identity||'').replace(/\D/g,'');
  const phone05  = toLocal05(phone||'');

  await page.waitForFunction(() => !!document.querySelectorAll('input[type="radio"][name="ss"]').length, {timeout:2000}).catch(()=>{});
  await page.waitForSelector('#SearchBox120', { visible:true, timeout:2000 });

  await typeSlow(page, '#SearchBox120', idDigits, 100);

  await page.evaluate(() => {
    const el = document.querySelector('#SearchBox120');
    if (el) {
      ['input','keyup','keydown','change'].forEach(ev => el.dispatchEvent(new Event(ev, {bubbles:true})));
      try { if (typeof window.suggestme120 === 'function') window.suggestme120(el.value, new KeyboardEvent('keyup')); } catch(_) {}
    }
  });

  await page.focus('#SearchBox120');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  const clickedDirect = await page.evaluate(() => {
    const li = document.querySelector('li[onclick^="fillSearch120"], .searchsugg120 li');
    if (li) { li.click(); return true; }
    return false;
  });
  if (clickedDirect) return true;

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const list = await readApptSuggestions(page);
    const enriched = list.map(it => ({ ...it, parsed: parseSuggestionText(it.text) }));
    const match = enriched.find(it => phonesEqual05(it.parsed.phone, phone05));
    if (match) {
      await page.evaluate((idx) => {
        const lis = document.querySelectorAll('li[onclick^="fillSearch120"], .searchsugg120 li');
        if (lis && lis[idx]) lis[idx].click();
      }, match.idx);
      return true;
    }

    await page.evaluate(() => {
      const el = document.querySelector('#SearchBox120');
      if (el) ['input','keyup','keydown','change'].forEach(ev => el.dispatchEvent(new Event(ev, {bubbles:true})));
      try { if (typeof window.suggestme120 === 'function') window.suggestme120(el.value, new KeyboardEvent('keyup')); } catch(_) {}
    });

    const pickedInFrame = await (async () => {
      for (const f of page.frames()) {
        const li = await f.$('li[onclick^="fillSearch120"]');
        if (li) { await li.click(); return true; }
      }
      return false;
    })();
    if (pickedInFrame) return true;

    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
  }

  const fallback = await pickFirstSuggestionOnAppointments(page, 3000);
  if (fallback) return true;

  throw new Error('تعذّر اختيار المريض من الاقتراحات');
}

/** ===== New-File page ===== */
async function openNewFilePage(page){
  page.on('dialog', async d => { try { await d.accept(); } catch(_) {} });

  await page.goto('https://phoenix.imdad.cloud/medica13/stq_add.php', { waitUntil: 'domcontentloaded' }).catch(()=>{});
  const gotDirect = await page.waitForSelector('#fname', { timeout: 7000 }).then(()=>true).catch(()=>false);
  if (gotDirect) return true;

  await page.goto('https://phoenix.imdad.cloud/medica13/home2.php', { waitUntil: 'domcontentloaded' }).catch(()=>{});
  const clicked = await page.evaluate(()=>{
    const links = Array.from(document.querySelectorAll('a'));
    const a = links.find(x=>{
      const t=(x.textContent||'').trim();
      const href = (x.getAttribute && x.getAttribute('href')) || '';
      return (href.includes('stq_add.php')) || /فتح ملف جديد|إضافة مريض|ملف جديد/i.test(t);
    });
    if (a) { a.click(); return true; }
    return false;
  });
  if (clicked) {
    await page.waitForNavigation({ waitUntil:'domcontentloaded', timeout: 12000 }).catch(()=>{});
  } else {
    await page.goto('https://phoenix.imdad.cloud/medica13/stq_add.php', { waitUntil: 'domcontentloaded' }).catch(()=>{});
  }

  return await page.waitForSelector('#fname', { timeout: 7000 }).then(()=>true).catch(()=>false);
}

/** ===== Identity typing + verify ===== */
async function typeIdentityAndVerify(page, selector, identityDigits, range = [140, 200], settleMs = 280) {
  const [minD, maxD] = range;
  const d = String(toAsciiDigits(identityDigits) || '').replace(/\D/g,'');
  if (!d) return false;

  await page.waitForSelector(selector, { visible: true, timeout: 30000 });
  await page.focus(selector);
  await page.$eval(selector, el => { el.value = ''; });

  for (let i = 0; i < d.length; i++) {
    const ch = d[i];
    const delay = i >= 7 ? Math.min(maxD, minD + 60) : minD;
    await page.type(selector, ch, { delay });
  }
  await sleep(settleMs);

  let rbDigits = await page.$eval(selector, el => (String(el.value||'').replace(/\D/g,'')));
  if (rbDigits.endsWith(d)) return true;

  await page.$eval(selector, (el,v)=>{
    el.value = v;
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'0'}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
  }, d);

  await sleep(settleMs);
  rbDigits = await page.$eval(selector, el => (String(el.value||'').replace(/\D/g,'')));
  return rbDigits.endsWith(d);
}
async function triggerSuggestions(page, selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    ['input','keyup','keydown','change'].forEach(ev =>
      el.dispatchEvent(new Event(ev, { bubbles: true })));
    el.blur(); el.focus();
    try {
      if (typeof window.suggestme122 === 'function') {
        window.suggestme122(el.value, new KeyboardEvent('keyup'));
      }
    } catch (_) {}
  }, selector);
}
async function waitAndPickFirstIdentitySuggestion(page, timeoutMs = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const picked = await page.evaluate(() => {
      const lis = document.querySelectorAll('li[onclick^="fillSearch12"]');
      if (lis && lis.length) { lis[0].click(); return true; }
      return false;
    });
    if (picked) return true;
    await page.evaluate(() => {
      const el = document.querySelector('#navbar-search-input, input[name="name122"]');
      if (el) {
        ['input','keyup','keydown','change'].forEach(ev=> el.dispatchEvent(new Event(ev, { bubbles: true })));
      }
    });
    await sleep(250);
  }
  return false;
}

async function searchSuggestionsByName(page, fullName){
  const selector = '#navbar-search-input, input[name="name122"]';
  await page.evaluate(()=>{ const el = document.querySelector('#navbar-search-input, input[name="name122"]'); if (el) el.value = ''; });
  await typeSlow(page, selector, fullName, 140);

  const deadline = Date.now() + 25000;
  let items = [];
  while (Date.now() < deadline) {
    items = await readNameSuggestions(page);
    if (items.length) break;
    await page.evaluate((sel)=>{
      const el = document.querySelector(sel);
      if(!el) return;
      ['input','keyup','keydown','change'].forEach(ev=> el.dispatchEvent(new Event(ev, { bubbles: true })));
      el.blur(); el.focus();
      try { if (typeof window.suggestme122 === 'function') window.suggestme122(el.value, new KeyboardEvent('keyup')); } catch(e){}
    }, selector);
    await sleep(350);
  }
  return items.map(it => ({ ...it, parsed: parseSuggestionText(it.text) }));
}

async function searchSuggestionsByPhoneOnNavbar(page, phone05){
  const selector = '#navbar-search-input, input[name="name122"]';
  await page.evaluate(()=>{ const el = document.querySelector('#navbar-search-input, input[name="name122"]'); if (el) el.value = ''; });
  await typeSlow(page, selector, phone05, 140);

  const deadline = Date.now() + 12000;
  let items = [];
  while (Date.now() < deadline) {
    items = await readNameSuggestions(page);
    if (items.length) break;
    await page.evaluate((sel)=>{
      const el = document.querySelector(sel);
      if(!el) return;
      ['input','keyup','keydown','change'].forEach(ev=> el.dispatchEvent(new Event(ev, { bubbles: true })));
      el.blur(); el.focus();
    }, selector);
    await sleep(300);
  }
  return items.map(it => ({ ...it, parsed: parseSuggestionText(it.text) }));
}

async function searchSuggestionsByPhoneOnAppointments(page, phone05){
  await page.goto('https://phoenix.imdad.cloud/medica13/appoint_display.php', { waitUntil:'domcontentloaded' }).catch(()=>{});
  await typeSlow(page, '#SearchBox120', phone05, 140);

  const deadline = Date.now() + 12000;
  let items = [];
  while (Date.now() < deadline) {
    items = await readApptSuggestions(page);
    if (items.length) break;
    await page.evaluate(()=>{
      const el = document.querySelector('#SearchBox120');
      if (el) ['input','keyup','keydown','change'].forEach(ev=> el.dispatchEvent(new Event(ev, { bubbles: true })));
    });
    await sleep(300);
  }
  return items.map(it => ({ ...it, parsed: parseSuggestionText(it.text) }));
}

/** ===== Open patient by identity then verify phone ===== */
async function searchAndOpenPatientByIdentity(page, { identityDigits, expectedPhone05 }) {
  const selector = '#navbar-search-input, input[name="name122"]';
  await page.evaluate(()=>{ const el = document.querySelector('#navbar-search-input, input[name="name122"]'); if (el) el.value = ''; });

  const digi = toAsciiDigits(identityDigits||'').replace(/\D/g,'');
  const typedOk = await typeIdentityAndVerify(page, selector, digi, [140, 200], 300);
  if (!typedOk) return { ok:false, reason:'id_type_mismatch' };

  await triggerSuggestions(page, selector);
  const pickedFirst = await waitAndPickFirstIdentitySuggestion(page, 12000);
  if (!pickedFirst) return { ok:false, reason:'no_suggestions' };

  const patientHref = await page.evaluate(()=>{
    const a1 = document.querySelector('a[href^="stq_search2.php?id="]');
    if (a1) return a1.getAttribute('href');
    const icon = document.querySelector('a i.far.fa-address-card');
    if (icon && icon.closest('a')) return icon.closest('a').getAttribute('href');
    return '';
  });
  if (!patientHref) return { ok:false, reason:'no_patient_link' };

  const fileId = ((patientHref.match(/id=(\d+)/) || [])[1] || '') || extractFileId(patientHref);
  await page.goto(`https://phoenix.imdad.cloud/medica13/${patientHref}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await page.waitForTimeout(1000);

 // ✔️ طالما فتح ملف المريض بالهوية نعتبره صحيح
return { ok: true, fileId };

}
/** ===== Duplicate phone detect ===== */
async function isDuplicatePhoneWarning(page){
  try {
    const found = await page.evaluate(()=>{
      const txt = (document.body.innerText||'').replace(/\s+/g, ' ');
      return /رقم هاتف موجود يخص المريض\s*:|رقم الجوال موجود|Existing phone number|Phone number already exists/i.test(txt);
    });
    return !!found;
  } catch { return false; }
}

/** ===== Pre-check by phone ===== */
async function existsPatientByPhone(page, phone05){
  let items = await searchSuggestionsByPhoneOnNavbar(page, phone05);
  if (items.some(it => phonesEqual05(it.parsed.phone, phone05))) return true;

  items = await readApptSuggestions(page);
  if (items.some(it => phonesEqual05(parseSuggestionText(it.text).phone, phone05))) return true;

  return false;
}

/** ===== WhatsApp OTP ===== */
const otpStore = {};
const otpThrottle = {};
console.log('ENV INSTANCE_ID:', process.env.INSTANCE_ID);
console.log('ENV ACCESS_TOKEN:', process.env.ACCESS_TOKEN);

app.post('/send-otp', async (req, res) => {
  try {

    // ⛔ تخطي OTP إذا المستخدم موجود في Redis
    const idDigits = toAsciiDigits(req.body?.identity || '').replace(/\D/g,'');
    const cached = await getLoginCache(idDigits);
    if (cached) {
      return res.json({ success: true, skipped: true });
    }

    let { phone } = req.body || {};

    const orig = phone;
    phone = normalizePhoneIntl(phone);

    if (!/^9665\d{8}$/.test(phone)) {
      return res.status(400).json({ success:false, message:'رقم الجوال غير صحيح' });
    }

    const now = Date.now();
    const last = otpThrottle[phone] || 0;
    const diff = Math.floor((now - last)/1000);
    if (diff < 60) {
      return res.status(429).json({ success:false, message:`أعد المحاولة بعد ${60-diff} ثانية`, retryAfter: 60-diff });
    }

    const otp = Math.floor(100000 + Math.random() * 900000);
    otpStore[phone] = { code: otp, ts: now };
    otpThrottle[phone] = now;
    console.log('OTP to:', phone, 'code:', otp);

    if (!INSTANCE_ID || !ACCESS_TOKEN || INSTANCE_ID==='CHANGE_ME' || ACCESS_TOKEN==='CHANGE_ME') {
      return res.status(500).json({ success:false, message:'إعدادات الإرسال غير مهيأة (ENV)' });
    }

    const msg = `رمز التحقق: ${otp} - Phoenix Clinic`;
    const url = `https://mywhats.cloud/api/send?number=${phone}&type=text&message=${encodeURIComponent(msg)}&instance_id=${INSTANCE_ID}&access_token=${ACCESS_TOKEN}`;
    await axios.get(url, { timeout: 8000 }).catch(() => {
  console.warn('⚠️ OTP delayed – skipping block');
});


    res.json({ success:true, phoneIntl: phone, phoneLocal: toLocal05(orig) });
  } catch (e) {
    console.error('/send-otp error', e?.message||e);
    res.status(500).json({ success:false, message:'فشل إرسال الرسالة' });
  }
});
function verifyOtpInline(phone, otp){
  if(SKIP_OTP_FOR_TESTING) return true;
  const intl = normalizePhoneIntl(phone);
  const rec = otpStore[intl];
  return !!(rec && String(rec.code)===String(otp));
}
async function processLoginQueue() {
  if (activeLogins >= MAX_LOGIN_WORKERS) return;
  if (!loginQueue.length) return;

  const { req, res } = loginQueue.shift();
  activeLogins++;

  handleLogin(req, res)
    .catch(e => {
      console.error('[LOGIN QUEUE ERROR]', e);
      res.json({ success:false, message:'تعذّر تسجيل الدخول حاليًا' });
    })
    .finally(() => {
      activeLogins--;
      processLoginQueue();
    });
}

app.post('/api/login', (req, res) => {
  loginQueue.push({ req, res });
  processLoginQueue();
});

    

   async function handleLogin(req, res) {
  try {
    const { identity, phone } = req.body || {};


    const idDigits = toAsciiDigits(identity || '').replace(/\D/g,'');
    const phone05  = toLocal05(phone);

    // ================================
    // 🚀 FAST LOGIN FROM REDIS (NO OTP)
    // ================================
    const cached = await getLoginCache(idDigits);
    if (cached) {
      // ⛔ لا OTP
      // ⛔ لا Puppeteer
      setBookingAuth(idDigits, cached.fileId);

      return res.json({
        success: true,
        exists: true,
        fileId: cached.fileId,
        cached: true,
        go: 'appointments'
      });
    }

    // ================================
    // ⬇️ من هنا فصاعدًا: مستخدم جديد فقط
    // ================================

  // ❌ OTP disabled


    // ===== Puppeteer =====
    const browser = await getSharedBrowser();
    const page = await browser.newPage();
    await prepPage(page);

    let account;
    try {
      // 🔐 Booking bot uses dedicated account
await loginToImdad(page, BOOKING_ACCOUNT);

console.log('[BOOK][LOGIN OK]', 'booking bot logged in');

      const result = await searchSuggestionsByPhoneOnNavbar(page, phone05);


      if (!result.ok) {
        await page.close();
        releaseAccount(account);
        return res.json({
          success: true,
          exists: false,
          go: 'new-file'
        });
      }

      await page.close();
      releaseAccount(account);

      // 💾 حفظ دائم في Redis
      await setLoginCache(idDigits, {
        phone05,
        fileId: result.fileId
      });

      setBookingAuth(idDigits, result.fileId);

      return res.json({
        success: true,
        exists: true,
        fileId: result.fileId,
        go: 'appointments'
      });

    } catch (e) {
      try { await page.close(); } catch {}
      
      return res.json({ success:false, message:'تعذر التحقق الآن' });
    }

  } catch (e) {
    console.error('[LOGIN ERROR]', e);
    return res.json({ success:false, message:'خطأ أثناء تسجيل الدخول' });
  }
}




/** ===== Read identity ===== */
async function readIdentityStatus(page, fileId) {
  console.log('[IMDAD] checking identity…');
  await page.goto(`https://phoenix.imdad.cloud/medica13/stq_edit.php?id=${fileId}`, { waitUntil:'domcontentloaded' }).catch(()=>{});

  try {
    await page.waitForSelector('#ssn', { timeout: 7000 });
    const ssnVal = await page.$eval('#ssn', el => (el.value || '').trim());
    const digits = toAsciiDigits(ssnVal).replace(/\D/g,'');
    const hasIdentity = !!(digits && !/^0+$/.test(digits) && digits.length >= 8 && !/^05\d{8}$/.test(digits));
    return { hasIdentity, ssnVal };
  } catch (_) {}

  const ssnVal = await page.evaluate(()=>{
    function toAscii(s){const map={'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'};return String(s).replace(/[٠-٩]/g, d=>map[d]||d);}
    const tds = Array.from(document.querySelectorAll('td[height="29"]'));
    for(const td of tds){
      const val = (td.textContent||'').trim();
      const ascii = toAscii(val).replace(/\s+/g,' ');
      const digits = ascii.replace(/\D/g,'');
      if(/^05\d{8}$/.test(digits)) continue;
      if (digits && !/^0+$/.test(digits) && digits.length >= 8) return digits;
    }
    return '';
  });

  const digits = toAsciiDigits(ssnVal).replace(/\D/g,'');
  const hasIdentity = !!(digits && !/^0+$/.test(digits) && digits.length >= 8 && !/^05\d{8}$/.test(digits));
  return { hasIdentity, ssnVal };
}

app.post('/api/update-identity', async (req, res) => {
  return res.json({
    success: false,
    message: 'تم تعطيل استكمال البيانات'
  });
});


/** ===== /api/create-patient ===== */
app.post('/api/create-patient', async (req, res) => {
  const MASTER_TIMEOUT_MS = 90000;
  const masterTimeout = new Promise((_, rej)=> setTimeout(()=>rej(new Error('timeout_master')), MASTER_TIMEOUT_MS));

  const handler = (async ()=>{
    try{
      let { fullName, phone, nationalId, gender, nationalityValue, day, month, year, otp } = req.body || {};

      const _isTripleName = (n)=> (n||'').trim().split(/\s+/).filter(Boolean).length === 3;
      const _isSaudi05 = (v)=> /^05\d{8}$/.test(toAsciiDigits(v||'').replace(/\D/g,''));
      const _normalize = (s='') => (s||'').replace(/\s+/g,' ').trim();

      if(!_isTripleName(fullName)) return res.json({ success:false, message:'الاسم الثلاثي مطلوب' });
      if(!_isSaudi05(phone))      return res.json({ success:false, message:'رقم الجوال 05xxxxxxxx' });
      if(!nationalId)             return res.json({ success:false, message:'رقم الهوية مطلوب' });
      if(!gender)                 gender='1';
      if(!day || !month || !year) return res.json({ success:false, message:'تاريخ الميلاد (يوم/شهر/سنة) مطلوب' });
      if(!verifyOtpInline(phone, otp)) return res.json({ success:false, message:'OTP غير صحيح', reason:'otp' });

      const phone05 = toLocal05(phone);
      const browser = await getSharedBrowser();

      const page = await browser.newPage(); await prepPage(page);
      page.on('dialog', async d => { try { await d.accept(); } catch(_) {} });

      let account=null;
      try{
        account = await acquireAccountWithTimeout(20000);
        await loginToImdad(page, account);

        if (await existsPatientByPhone(page, phone05)) {
          try { if (!WATCH) await page.close(); } catch(_){}
          if(account) releaseAccount(account);
          return res.json({
            success:false,
            reason:'phone_exists',
            message:'لديك ملف مسجل لدينا، الرجاء تسجيل الدخول'
          });
        }

        const opened = await openNewFilePage(page);
        if (!opened) {
          try { if (!WATCH) await page.close(); } catch(_){}
          if(account) releaseAccount(account);
          return res.json({ success:false, message:'تعذّر فتح صفحة الملف الجديد' });
        }

        await page.waitForSelector('#fname', { timeout: 30000 });
        await page.waitForSelector('#phone', { timeout: 30000 });

        await page.$eval('#fname', (el,v)=>{ el.value=v; }, _normalize(fullName));
        await page.$eval('#ssn', (el,v)=>{ el.value=v; }, String(nationalId));

        await page.select('#day12',   String(day));
        await page.select('#month12', String(month));
        await page.select('#year12',  String(year));
        await page.select('#gender', String(gender));

        if (nationalityValue) {
          await page.evaluate((val)=>{
            const sel = document.querySelector('#n');
            if(!sel) return;
            if ([...sel.options].some(o=>o.value===String(val))) {
              sel.value = String(val);
              sel.dispatchEvent(new Event('change', {bubbles:true}));
            }
          }, String(nationalityValue));
        }

        async function typePhoneSlowAndEnsure(p){
          await page.$eval('#phone', (el)=>{ el.value=''; });
          for(let i=0;i<p.length;i++){
            const ch = p[i];
            const delay = i>=7 ? 160 : 120;
            await page.type('#phone', ch, { delay });
          }
          await sleep(350);
          const readBack = await page.$eval('#phone', el => (el.value||'').trim());
          const digits = toAsciiDigits(readBack).replace(/\D/g,'');
          if(!/^05\d{8}$/.test(digits)){
            await page.$eval('#phone', (el)=>{ el.value=''; });
            for(const ch of p){ await page.type('#phone', ch, { delay: 170 }); }
            await sleep(450);
          }
        }

        await typePhoneSlowAndEnsure(phone05);

        await sleep(2000);
        if (await isDuplicatePhoneWarning(page)) {
          try { if (!WATCH) await page.close(); } catch(_){}
          if(account) releaseAccount(account);
          return res.json({
            success:false,
            reason:'phone_exists',
            message:'لديك ملف مسجل لدينا، الرجاء تسجيل الدخول'
          });
        }

        await page.waitForSelector('#submit', { timeout: 20000 });
        await page.evaluate(() => {
          const btn = document.querySelector('#submit');
          if (btn) { btn.disabled=false; btn.removeAttribute('disabled'); btn.click(); }
        });

        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
        await sleep(1500);

        if (await isDuplicatePhoneWarning(page)) {
          try { if (!WATCH) await page.close(); } catch(_){}
          if(account) releaseAccount(account);
          return res.json({
            success:false,
            reason:'phone_exists',
            message:'لديك ملف مسجل لدينا، الرجاء تسجيل الدخول'
          });
        }

        try { if (!WATCH) await page.close(); } catch(_){}
        if(account) releaseAccount(account);
        return res.json({ success:true, message:'تم إنشاء الملف بنجاح' });

      }catch(e){
        console.error('/api/create-patient error', e?.message||e);
        try{ if (!WATCH) await page.close(); }catch(_){}
        if(account) releaseAccount(account);
        if(String(e?.message||e)==='imdad_busy'){
          return res.json({ success:false, reason:'imdad_busy', message:'النظام مشغول حاليًا، حاول بعد قليل' });
        }
        if(String(e?.message||e)==='timeout_master'){
          return res.json({ success:false, reason:'timeout', message:'المهلة انتهت أثناء إنشاء الملف' });
        }
        return res.json({ success:false, message:'فشل إنشاء الملف: ' + (e?.message||e) });
      }
    }catch(e){
      return res.json({ success:false, message:'خطأ غير متوقع' });
    }
  })();

  Promise.race([handler, masterTimeout]).catch(async (_e)=>{
    try { return res.json({ success:false, reason:'timeout', message:'المهلة انتهت' }); }
    catch(_) { /* ignore */ }
  });
});

/** ===== Helper: 1 month view ===== */
async function applyOneMonthView(page){
  const didSet = await page.evaluate(()=>{
    const selects = Array.from(document.querySelectorAll('select'));
    for (const sel of selects) {
      const opts = Array.from(sel.options || []);
      const opt =
        opts.find(o => String((o.textContent||'').trim()).toLowerCase() === '1 month') ||
        opts.find(o => String(o.value||'').includes('day_no=30'));
      if (opt) {
        try {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles:true }));
          if (/appoint_display\.php/i.test(String(opt.value||''))) {
            try { window.location.href = opt.value; } catch(_) {}
          }
          return true;
        } catch(_){}
      }
    }
    return false;
  });
  if (didSet) {
    await page.waitForNavigation({waitUntil:'domcontentloaded', timeout:120000}).catch(()=>{});
  }
  return didSet;
}

function findClinicRules(clinicStr) {
  return Object.values(CLINIC_RULES).find(r => r.match.test(clinicStr));
}

function toMinutes(t) {
  const [H, M='0'] = t.split(':');
  return (+H)*60 + (+M);
}

function inRange(t, from, to) {
  const m = toMinutes(t);
  return m >= from && m <= to;
}
function isFriOrSat(dateStr) {
  // dateStr: "DD-MM-YYYY"
  const [D, M, Y] = String(dateStr || '').split('-').map(Number);
  const day = new Date(Date.UTC(Y, M - 1, D)).getUTCDay(); // 5=Fri, 6=Sat
  return { isFri: day === 5, isSat: day === 6 };
}

function parseValueToDateTime(valueOrObj) {
  // يدعم: {value:'DD-MM-YYYY*HH:MM'} أو string value
  const v = typeof valueOrObj === 'string' ? valueOrObj : (valueOrObj?.value || '');
  const [date, time24] = String(v).split('*');
  return { date: (date || '').trim(), time24: (time24 || '').trim() };
}

function applyClinicRulesToTimes(times, clinicStr, effectivePeriod, rules) {
  if (!rules) return times || [];

  let out = Array.isArray(times) ? [...times] : [];

  // 1) فلترة الجمعة/السبت
  out = out.filter(t => {
    const { date } = parseValueToDateTime(t);
    if (!date) return false;
    const { isFri, isSat } = isFriOrSat(date);
    if (isFri && rules.allowFriday === false) return false;
    if (isSat && rules.allowSaturday === false) return false;
    return true;
  });

  // 2) فلترة الفترة (صباح/مساء) حسب حدود من-إلى
  if (effectivePeriod === 'morning' && rules.morning) {
    out = out.filter(t => {
      const { time24 } = parseValueToDateTime(t);
      return time24 && inRange(time24, rules.morning.from, rules.morning.to);
    });
  }

  if (effectivePeriod === 'evening' && rules.evening) {
    out = out.filter(t => {
      const { time24 } = parseValueToDateTime(t);
      return time24 && inRange(time24, rules.evening.from, rules.evening.to);
    });
  }

  // 3) تشقير/تنظيف البشرة: عرض بالساعة فقط + منع 45/90
  if (rules.hourlyOnly) {
    const buckets = new Map();

    for (const t of out) {
      const { date, time24 } = parseValueToDateTime(t);
      if (!date || !time24) continue;

      const [H, M = '0'] = time24.split(':').map(Number);

      // ✅ فقط HH:00
      if (M !== 0) continue;

      const key = `${date}|${H}`;
      if (!buckets.has(key)) {
        const h12 = (H % 12) || 12;
        const am = H < 12;
        buckets.set(key, {
          value: `${date}*${String(H).padStart(2,'0')}:00`,
          label: `${date} - ${h12}:00 ${am ? 'ص' : 'م'}`
        });
      }
    }

    out = [...buckets.values()].sort((a,b)=>a.label.localeCompare(b.label,'ar'));
  }

  return out;
}


/** ===== /api/times ===== */
app.post('/api/times', async (req, res) => {
  try {
    const { clinic, month, period } = req.body || {};
   if (!clinic) {
  return res.status(400).json({ times: [], error: 'العيادة مفقودة' });
}


    const clinicStr = String(clinic || '');

    // تحديد الفترة تلقائيًا من اسم العيادة
    const autoPeriod =
      /\*\*الفترة الثانية$/.test(clinicStr) ? 'evening' :
      (/\*\*الفترة الاولى$/.test(clinicStr) ? 'morning' : null);

    const effectivePeriod = period || autoPeriod;
    // ===== FAST PATH (Redis) =====
const cachedPrefetch = await getClinicTimesFromRedis(clinic);

if (cachedPrefetch && Array.isArray(cachedPrefetch.times)) {
  const rules = findClinicRules(clinicStr);
  let times = applyClinicRulesToTimes(
    cachedPrefetch.times,
    clinicStr,
    effectivePeriod,
    rules
  );

  // ⛔ فلترة المواعيد المقفولة (مهم للتشقير)
  const visibleTimes = [];
  for (const t of times) {
    const { date, time24 } = parseValueToDateTime(t);
    const locked = await isSlotLocked(clinicStr, date, time24);
    if (!locked) visibleTimes.push(t);
  }

  return res.json({ times: visibleTimes, cached: true, source: 'prefetch' });
}




    // ===== الكاش =====
    const cacheKey = makeTimesKey({ clinic, month, period: effectivePeriod || '' });
    if (timesInFlight.has(cacheKey)) {
  const data = await timesInFlight.get(cacheKey);
  return res.json({ times: data, cached: true, shared: true });
}

   const cached = await getTimesCache(cacheKey);

    if (cached && cached.length > 0) {
      return res.json({ times: cached, cached: true });
    }

    if (timesInFlight.has(cacheKey)) {
      const data = await timesInFlight.get(cacheKey);
      return res.json({ times: data, cached: true, shared: true });
    }

    // ===== إعدادات العيادات =====
    const baseClinicName = clinicStr.split('**')[0].trim();



    // ===== job (Puppeteer) =====
   
    const job = (async () => {
      const browser = await getSharedBrowser();
      const page = await browser.newPage();
      await prepPage(page);

      try {
        await loginToImdad(page, { user: '3333333333', pass: '3333333333' });
        await gotoAppointments(page);

       // اختيار العيادة
const clinicValue = await page.evaluate((name) => {

  // ✅ تشقير وتنظيف البشرة لها رابط ثابت في إمداد
  if (name.startsWith('عيادة تنظيف البشرة')) {
    return 'appoint_display.php?clinic_id=137&per_id=2&day_no=7';
  }

  const normalize = s =>
    String(s || '')
      .replace(/\s+/g, ' ')
      .replace(/[أإآ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .trim();

  const target = normalize(name);
  const opts = Array.from(document.querySelectorAll('#clinic_id option'));

  const f = opts.find(o =>
    normalize(o.textContent) === target ||
    normalize(o.value) === target
  );

  return f ? f.value : null;
}, clinic);


        if (!clinicValue) throw new Error('clinic_not_found');

        await page.evaluate((val) => {
          const sel = document.querySelector('#clinic_id');
          sel.value = val;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          if (val) window.location.href = val;
        }, clinicValue);

        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120000 }).catch(()=>{});

        // عرض شهر واحد
        await applyOneMonthView(page);

        // اختيار الشهر
        const pickedMonth = await page.evaluate((wanted) => {
          const sel = document.querySelector('#month1');
          if (!sel) return null;
          const w = String(wanted).trim();
          const opt = [...sel.options].find(o =>
            o.text.trim() === w || o.value.includes(`month=${w}`)
          );
          if (!opt) return null;
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          if (opt.value) window.location.href = opt.value;
          return opt.value;
        }, month);

        if (!pickedMonth) throw new Error('month_not_found');

        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120000 }).catch(()=>{});

        // ⏳ انتظر جدول المواعيد يكتمل (الأهم)
        await page.waitForSelector(
          'input[type="radio"][name="ss"]',
          { timeout: 45000 }
        );

        // قراءة المواعيد
        const raw = await page.evaluate(() => {
          return Array.from(
            document.querySelectorAll('input[type="radio"][name="ss"]:not(:disabled)')
          ).map(r => {
            const [date, time24] = (r.value || '').split('*');
            return {
              value: r.value,
              date: (date||'').trim(),
              time24: (time24||'').trim()
            };
          });
        });

   let filtered = raw;

// طبق القواعد على raw أولاً
const rules = findClinicRules(clinicStr);

// حوّل raw إلى times
let times = filtered.map(x => ({
  value: x.value,
  label: `${x.date} - ${to12h(x.time24)}`
}));

// طبّق القواعد (وقت/ايام/تشقير)
times = applyClinicRulesToTimes(times, clinicStr, effectivePeriod, rules);

// خزنه كـ Prefetch-style (اختياري)
// await setClinicTimesToRedis(clinicStr, times);

return times;


      } finally {
        try { if (!WATCH) await page.close(); } catch(_) {}
      }
    })();

    timesInFlight.set(cacheKey, job);

    try {
 const times = await job;

if (!Array.isArray(times) || times.length === 0) {
  throw new Error('no_times_found');
}

await setTimesCache(cacheKey, times);
// ⛔ إخفاء الأوقات المقفولة فورًا
// ⛔ إخفاء الأوقات المقفولة فورًا (خصوصًا التشقير)
const visibleTimes = [];

for (const t of times) {
  const { date, time24 } = parseValueToDateTime(t);

  // 🔒 تحقق Redis Lock (المصدر الحقيقي)
  const locked = await isSlotLocked(clinicStr, date, time24);

  if (!locked) {
    visibleTimes.push(t);
  }
}

return res.json({ times: visibleTimes, cached: false });


} finally {
  timesInFlight.delete(cacheKey);
}



  } catch (e) {
    return res.json({ times: [], error: e?.message || String(e) });
  }
});

/* ================= Fetch Times (1 month auto) ================= */
async function fetchTimesForClinic30Days(clinic) {

  const browser = await getSharedBrowser();
  const page = await browser.newPage();
  await prepPage(page);

  try {
    // تسجيل دخول
    await loginToImdad(page, { user: '3333333333', pass: '3333333333' });
    await gotoAppointments(page);

    // اختيار العيادة
    const clinicValue = await page.evaluate((name) => {

      // تنظيف البشرة (رابط ثابت)
      if (name.startsWith('تشقير') || name.startsWith('عيادة تنظيف البشرة')) {
        return 'appoint_display.php?clinic_id=137&per_id=2&day_no=7';
      }

      const normalize = s =>
        String(s || '')
          .replace(/\s+/g, ' ')
          .replace(/[أإآ]/g, 'ا')
          .replace(/ة/g, 'ه')
          .trim();

      const target = normalize(name);
      const opts = Array.from(document.querySelectorAll('#clinic_id option'));

      const f = opts.find(o =>
        normalize(o.textContent) === target ||
        normalize(o.value) === target
      );

      return f ? f.value : null;
    }, clinic);

    if (!clinicValue) {
      throw new Error('clinic_not_found');
    }

    await page.evaluate((val) => {
      const sel = document.querySelector('#clinic_id');
      sel.value = val;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      if (val) window.location.href = val;
    }, clinicValue);

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120000 });

    // ⭐ اختيار 1 month تلقائيًا
    await applyOneMonthView(page);

    // انتظار جدول المواعيد
    await page.waitForSelector(
      'input[type="radio"][name="ss"]',
      { timeout: 45000 }
    );

    // قراءة الأوقات
   const times = await page.evaluate(() => {
  function to12h(t){
    let [H,M='0']=t.split(':');
    H=+H; M=String(+M).padStart(2,'0');
    const am = H < 12;
    let h = H % 12; if (h===0) h=12;
    return `${h}:${M} ${am?'ص':'م'}`;
  }

  return Array.from(
    document.querySelectorAll('input[type="radio"][name="ss"]:not(:disabled)')
  ).map(r => {
    const [date, time24] = (r.value || '').split('*');
    return {
      value: r.value,
      label: `${date} - ${to12h(time24)}`
    };
  });
});


    return times || [];

  } finally {
    try { if (!WATCH) await page.close(); } catch (_) {}
  }
}



/** ===== دالة الضغط والتأكيد للحجز (إصدار قوي للهيدلس) ===== */
async function clickReserveAndConfirm(page) {
  const BOOK_DEBUG = process.env.BOOK_DEBUG === '1';
  async function dumpDebug(tag='reserve') {
    try {
      const ts = Date.now();
      const png = `/tmp/${tag}-${ts}.png`;
      const html = `/tmp/${tag}-${ts}.html`;
      await page.screenshot({ path: png, fullPage: true }).catch(()=>{});
      const body = await page.content().catch(()=> '');
      if (body) require('fs').writeFileSync(html, body);
      console.log(`[BOOK][debug] saved ${png} & ${html}`);
    } catch(_) {}
  }

  page.removeAllListeners('dialog');
  page.on('dialog', async d => { try { await d.accept(); } catch(_) {} });

  let serverSaved = false;
  const respPromise = page.waitForResponse(async (r) => {
    const u = r.url();
    if (/(appoint.*(save|reserve)|save_?appoint|appoint_save2?)\.php/i.test(u)) {
      try {
        const txt = await r.clone().text().catch(()=> '');
        if (/تم الحجز|Reserve\s*Done|Success|حجز ناجح/i.test(txt)) {
          serverSaved = true;
          return true;
        }
      } catch(_) {}
      return true;
    }
    return false;
  }, { timeout: 35000 }).catch(()=>false);

  async function pressInPage() {
    return await page.evaluate(() => {
      const cand = [
        document.querySelector('input[type="submit"][name="submit"]'),
        ...Array.from(document.querySelectorAll('input[type="submit"]')).filter(b => /حجز|Reserve/i.test((b.value||''))),
        document.querySelector('button#submit'),
        ...Array.from(document.querySelectorAll('button, input[type="button"]')).filter(b => /حجز|Reserve/i.test((b.textContent||b.value||''))),
      ].filter(Boolean);
      const btn = cand[0];
      if (!btn) return { pressed:false };
      btn.disabled = false; btn.removeAttribute?.('disabled');
      const rect = btn.getBoundingClientRect?.();
      if (rect) window.scrollTo({ top: rect.top + window.scrollY - 140, behavior: 'smooth' });
      btn.click();
      btn.dispatchEvent(new Event('click', { bubbles: true }));
      const form = btn.closest('form');
      if (form) {
        form.noValidate = true;
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        try { form.submit?.(); } catch(_){}
      }
      return { pressed:true };
    });
  }

  async function pressWithMouse() {
    const h = await page.$('input[type="submit"][name="submit"], input[type="submit"], button#submit, button');
    if (!h) return false;
    const box = await h.boundingBox().catch(()=>null);
    if (!box) return false;
    await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
    await page.mouse.down();
    await page.mouse.up();
    return true;
  }

  await pressInPage();
  let ok = await Promise.race([
    respPromise.then(Boolean),
    page.waitForSelector('#popupContact, .swal2-container, .modal.show, .modal.fade.show', { visible: true, timeout: 25000 }).then(()=>true).catch(()=>false),
    page.waitForFunction(() => /تم الحجز|Reserve\s*Done|حجز ناجح/i.test((document.body.innerText||'')), { timeout: 25000 }).then(()=>true).catch(()=>false),
    page.waitForFunction(() => /confirm|success/i.test(((document.querySelector('.toast, .alert-success, .alert.alert-success, .swal2-title')||{}).textContent||'')), { timeout: 25000 }).then(()=>true).catch(()=>false),
  ]);

  if (!ok) {
    await pressWithMouse();
    ok = await Promise.race([
      page.waitForSelector('#popupContact, .swal2-container, .modal.show, .modal.fade.show', { visible: true, timeout: 18000 }).then(()=>true).catch(()=>false),
      page.waitForFunction(() => /تم الحجز|Reserve\s*Done|حجز ناجح/i.test((document.body.innerText||'')), { timeout: 18000 }).then(()=>true).catch(()=>false),
      page.waitForTimeout(4000).then(()=>serverSaved),
    ]);
  }

  if (!ok) {
    await page.evaluate(() => {
      const forms = Array.from(document.querySelectorAll('form')).filter(f =>
        /appoint|reserve|save/i.test(f.action || '') ||
        Array.from(f.elements || []).some(e => /ss|submit|reserve/i.test(e.name || e.id || ''))
      );
      for (const f of forms) {
        try { f.noValidate = true; f.submit?.(); } catch(_){}
      }
    });
    ok = await Promise.race([
      page.waitForFunction(() => /تم الحجز|Reserve\s*Done|حجز ناجح/i.test((document.body.innerText||'')), { timeout: 12000 }).then(()=>true).catch(()=>false),
      page.waitForTimeout(3000).then(()=>serverSaved),
    ]);
  }

  const radioDisabled = await page.evaluate(() => {
    const r = document.querySelector('input[type="radio"][name="ss"]:checked');
    if (!r) return true;
    return r.disabled === true;
  });

  if (ok || serverSaved || radioDisabled) return true;
  if (BOOK_DEBUG) await dumpDebug('reserve-failed');
  throw new Error('لم تصل شاشة التأكيد من إمداد');
}


/** ===== Helper: Select Patient (robust, headless-friendly) ===== */
async function selectPatientOnAppointments(page, identity) {
  const toAscii = s => String(s||'').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[٠-٩]/g, m=>''); // احتياط
  const idText = toAscii(String(identity || '').trim()).replace(/\D/g,'');
  if (!idText) throw new Error('لا يوجد رقم هوية!');

  try { await page.bringToFront(); } catch(_) {}
  try { await page.setViewport({ width: 1280, height: 900 }); } catch(_) {}

  // تأكد أن الحقل قابل للكتابة 100%
  await page.waitForSelector('#SearchBox120', { visible: true, timeout: 30000 });
  await page.evaluate(() => {
    const el = document.querySelector('#SearchBox120');
    if (!el) return;
    el.removeAttribute?.('readonly');
    el.removeAttribute?.('disabled');
    el.disabled = false;
    el.readOnly = false;
    el.setAttribute?.('autocomplete','off');
    el.setAttribute?.('autocapitalize','off');
    el.setAttribute?.('inputmode','numeric');
    el.value = '';
    ['focus','click','input','keyup','keydown','change'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles:true })));
  });

  // مسار (A): كتابة بطيئة مضمونة
  const TYPE_DELAY = Number(process.env.FORCE_TYPE_SLOW_MS || 120);
  await page.click('#SearchBox120', { delay: 50 }).catch(()=>{});
  await page.focus('#SearchBox120').catch(()=>{});
  for (const ch of idText) {
    await page.type('#SearchBox120', ch, { delay: TYPE_DELAY }).catch(()=>{});
  }

  // تحفيز الاقتراحات بعد الكتابة
  await page.evaluate(() => {
    const box = document.querySelector('#SearchBox120');
    if (!box) return;
    ['input','keyup','keydown','change'].forEach(ev => box.dispatchEvent(new Event(ev, { bubbles: true })));
    try { if (typeof window.suggestme120 === 'function') window.suggestme120(box.value, new KeyboardEvent('keyup')); } catch(_) {}
  });

  // نبحث عن LI للاقتراح — مع بدائل متعددة
  const deadline = Date.now() + 15000;
  let picked = false;

  while (!picked && Date.now() < deadline) {
    // (1) نقر مباشر على LI إن وُجد
    try {
      const sel = await page.waitForSelector('li[onclick^="fillSearch120"], .searchsugg120 li', { timeout: 1200 });
      if (sel) {
        await page.evaluate(el => {
          el.scrollIntoView({ block: 'center' });
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles:true, cancelable:true }));
          el.dispatchEvent(new MouseEvent('mouseup',   { bubbles:true, cancelable:true }));
          el.click();
        }, sel);
        await page.waitForTimeout(400);
        const okReflected = await page.evaluate(() => {
          const hasLink = !!document.querySelector('a[href^="stq_search2.php?id="]');
          const hasFileInput = !!document.querySelector('input[name="file_id"], #file_id');
          const infoBlock = !!document.querySelector('.patient-info, .searchsugg120_selected');
          const box = document.querySelector('#SearchBox120');
          const looksName = box && /\D/.test((box.value||'').replace(/\s+/g,''));
          return hasLink || hasFileInput || infoBlock || looksName;
        });
        if (okReflected) { picked = true; break; }
      }
    } catch(_) {}

    // (2) مسار لوحة مفاتيح ArrowDown + Enter
    try {
      await page.keyboard.press('ArrowDown').catch(()=>{});
      await page.keyboard.press('Enter').catch(()=>{});
      await page.waitForTimeout(300);
      const ok = await page.evaluate(() => {
        const hasLink = !!document.querySelector('a[href^="stq_search2.php?id="]');
        const box = document.querySelector('#SearchBox120');
        return hasLink || (box && /\D/.test((box.value||'').replace(/\s+/g,'')));
      });
      if (ok) { picked = true; break; }
    } catch(_) {}

    // (3) fallback: setValue المباشر + تحفيز
    if (!picked) {
      await page.evaluate((val) => {
        const el = document.querySelector('#SearchBox120');
        if (!el) return;
        el.value = val;
        ['input','keyup','keydown','change'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles:true })));
        try { if (typeof window.suggestme120 === 'function') window.suggestme120(el.value, new KeyboardEvent('keyup')); } catch(_) {}
      }, idText);
      await page.waitForTimeout(300);
    }

    // (4) تفقد iframes
    for (const f of page.frames()) {
      try {
        const li = await f.$('li[onclick^="fillSearch120"], .searchsugg120 li');
        if (li) {
          await f.evaluate(el => {
            el.scrollIntoView({ block: 'center' });
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles:true, cancelable:true }));
            el.dispatchEvent(new MouseEvent('mouseup',   { bubbles:true, cancelable:true }));
            el.click();
          }, li);
          await page.waitForTimeout(400);
          const ok2 = await page.evaluate(() => !!document.querySelector('a[href^="stq_search2.php?id="]'));
          if (ok2) { picked = true; break; }
        }
      } catch(_) {}
    }
    if (picked) break;

    // (5) إعادة التحفيز
    await page.evaluate(() => {
      const box = document.querySelector('#SearchBox120');
      if (!box) return;
      ['input','keyup','keydown','change'].forEach(ev => box.dispatchEvent(new Event(ev, { bubbles:true })));
      try { if (typeof window.suggestme120 === 'function') window.suggestme120(box.value, new KeyboardEvent('keyup')); } catch(_) {}
    });
    await page.waitForTimeout(300);
  }

  if (!picked) {
    try {
      if (process.env.DEBUG_SCREENCAP === '1') {
        const path = require('path'), fs = require('fs');
        const dir = path.join(__dirname, 'debug');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        await page.screenshot({ path: path.join(dir, `select-fail-${Date.now()}.png`), fullPage: true });
        fs.writeFileSync(path.join(dir, `select-fail-${Date.now()}.html`), await page.content(), 'utf8');
        console.log('[DEBUG] saved select-fail files');
      }
    } catch(_) {}
    throw new Error('تعذّر اختيار المريض من الاقتراحات!');
  }

  await page.waitForTimeout(350);
}


/** ===== Booking queue (single) ===== */
app.post('/api/book', async (req, res) => {
  const { identity, clinic, time } = req.body || {};

  if (!clinic || !time) {
    return res.status(400).json({ success:false, message:'بيانات الحجز ناقصة' });
  }

  // time = "DD-MM-YYYY*HH:MM"
  const [date, time24] = String(time).split('*');

  // 🔒 قفل فوري
  const locked = await lockSlot(
    clinic,
    date,
    time24,
    toAsciiDigits(identity || 'unknown')
  );

  if (!locked) {
    return res.json({
      success: false,
      reason: 'slot_locked',
      message: 'هذا الموعد تم حجزه قبل قليل'
    });
  }
console.log(
  '[QUEUE][ADD]',
  'identity=', req.body?.identity,
  'clinic=', req.body?.clinic,
  'time=', req.body?.time
);

  // ⬅️ أدخل الحجز للطابور
  bookingQueue.push({ data: req.body });
  processQueue();

  // ⬅️ رجّع فورًا
  return res.json({
    success: true,
    go: 'success'
  });
});



async function processQueue() {
  if (processingBooking || !bookingQueue.length) return;
  processingBooking = true;

  const job = bookingQueue.shift();

 try {
  console.log(
    '[QUEUE][START]',
    'identity=', job.data?.identity,
    'clinic=', job.data?.clinic,
    'time=', job.data?.time
  );

  await bookNow(job.data);

  console.log(
    '[QUEUE][DONE]',
    'identity=', job.data?.identity
  );

} catch (e) {
  console.error(
    '[BOOK][FAILED]',
    'identity=', job?.data?.identity,
    'clinic=', job?.data?.clinic,
    'time=', job?.data?.time,
    'error=', e?.message || e
  );
} finally {
  processingBooking = false;
  processQueue(); // ⬅️ يبدأ اللي بعده فقط بعد ما يخلص هذا
}

}




/// ===== Booking flow (single) — V2 =====
async function bookNow({ identity, name, phone, clinic, month, time, note }) {
  console.log(
  '[BOOK][START]',
  'identity=', identity,
  'phone=', phone,
  'clinic=', clinic,
  'time=', time
);

  const browser = await getSharedBrowser();

  const page = await browser.newPage();
  await prepPage(page);

  let account = null;
  const delay = (ms=700)=>new Promise(r=>setTimeout(r,ms));

  try {
    await loginToImdad(page, BOOKING_ACCOUNT);


    await gotoAppointments(page);
    await delay();

    const clinicValue = await page.evaluate((wanted) => {
      const opts = Array.from(document.querySelectorAll('#clinic_id option'));
      const hit = opts.find(o => (o.textContent||'').trim() === wanted || (o.value||'') === wanted);
      return hit ? hit.value : null;
    }, String(clinic||'').trim());
    if (!clinicValue) throw new Error('');

    await Promise.all([
      page.waitForNavigation({ waitUntil:'domcontentloaded', timeout: 30000 }).catch(()=>{}),
      page.select('#clinic_id', clinicValue)
    ]);
    await delay();

    await applyOneMonthView(page);
    await page.waitForNavigation({ waitUntil:'domcontentloaded', timeout: 8000 }).catch(()=>{});
    await delay();

    if (month) {
      const wanted = String(month).match(/(\d{1,2})$/)?.[1] || String(month).trim();
      const changed = await page.evaluate((w)=>{
        const sel=document.querySelector('#month1'); if(!sel) return false;
        const opts=Array.from(sel.options||[]).map(o=>({value:o.value||'', text:(o.textContent||'').trim()}));
        const hit=opts.find(o=>o.text===w) || opts.find(o=>o.value.includes(`month=${w}`)) || opts.find(o=>o.text.endsWith(w)) || null;
        if(!hit) return false;
        try{ sel.value=hit.value; sel.dispatchEvent(new Event('change',{bubbles:true})); }catch(_){}
        try{ if(hit.value) window.location.href=hit.value; }catch(_){}
        return true;
      }, wanted);
      if (changed) {
        await page.waitForNavigation({ waitUntil:'domcontentloaded', timeout:12000 }).catch(()=>{});
        await delay();
      }
    }

    await selectPatientOnAppointments(page, toLocal05(phone));

    await delay();

    await page.evaluate(v=>{
      const el=document.querySelector('input[name="notes"],#notes,textarea[name="notes"]');
      if(el){ el.value=(v||'').trim(); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
    }, (note||'')).catch(()=>{});
    await page.evaluate(()=>{
      const g=document.querySelector('select[name="gender"]'); if(g && !g.value){ g.value='1'; g.dispatchEvent(new Event('change',{bubbles:true})); }
      const n=document.querySelector('select[name="nation_id"]'); if(n && !n.value){ n.value='1'; n.dispatchEvent(new Event('change',{bubbles:true})); }
    }).catch(()=>{});
    await delay();

    function normalizeWanted(v){
      const [date, hm='']=String(v||'').split('*'); let [H,M='0']=String(hm).split(':');
      return { date:String(date||'').trim(), H:String(+H), M:String(+M) };
    }
    const W = normalizeWanted(time);

    await page.waitForFunction(
      () => document.querySelectorAll('input[type="radio"][name="ss"]').length > 0,
      { timeout: 20000 }
    ).catch(()=>{});

    const picked = await page.evaluate(({date,H,M})=>{
      function eq(a,b){ return String(a)===String(b); }
      function matchValue(val,date,H,M){
        const parts=String(val||'').split('*'); if(parts.length<2) return false;
        const vDate=(parts[0]||'').trim(); const [vH,vM='0']=String(parts[1]||'').split(':');
        return eq(vDate,date)&&eq(String(+vH),H)&&eq(String(+vM),M);
      }
      const radios=Array.from(document.querySelectorAll('input[type="radio"][name="ss"]'));
      for(const r of radios){
        if(!r.disabled && matchValue(r.value,date,H,M)){
          const lab=r.closest('label');
          if(lab){ const rect=lab.getBoundingClientRect(); window.scrollTo({top:rect.top+window.scrollY-120,behavior:'smooth'}); lab.click(); }
          else { r.click(); }
          r.dispatchEvent(new Event('change',{bubbles:true}));
          return true;
        }
      }
      const wantHM=`${H}:${M}`;
      const spans=Array.from(document.querySelectorAll('.front-end.box span'));
      const hit=spans.find(s=>(s.textContent||'').includes(wantHM));
      if(hit){
        const lab=hit.closest('label');
        if(lab){
          const rect=lab.getBoundingClientRect(); window.scrollTo({top:rect.top+window.scrollY-120,behavior:'smooth'});
          lab.click();
          const r=lab.querySelector('input[type="radio"][name="ss"]'); if(r) r.dispatchEvent(new Event('change',{bubbles:true}));
          return true;
        }
      }
      return false;
    }, W);
    if (!picked) throw new Error(' ');

    await delay(600);
    console.log('[BOOK][RESERVE]', 'click reserve', 'clinic=', clinic, 'time=', time);

   const reserved = await clickReserveAndConfirm(page);

if (!reserved) {
  throw new Error('BOOKING_NOT_CONFIRMED');
}

    console.log(
  '[BOOK][SUCCESS]',
  'identity=', identity,
  'clinic=', clinic,
  'time=', time
);

    // ================== REDIS CLEAN (AFTER BOOKING) ==================
try {
  const clinicName = String(clinic || '').trim();

  // 1️⃣ حذف Prefetch cache
  await redis.del(clinicCacheKey(clinic));

  // 2️⃣ حذف كل times cache الخاصة بالعيادة (SCAN آمن)
  let cursor = '0';
  do {
    const res = await redis.scan(
      cursor,
      'MATCH',
      `times:${clinicName}*`,
      'COUNT',
      100
    );
    cursor = res[0];
    if (res[1].length) {
      await redis.del(res[1]);
    }
  } while (cursor !== '0');

  console.log('[REDIS] booking cache cleared for:', clinicName);
} catch (e) {
  console.warn('[REDIS CLEAN FAILED]', e?.message || e);
}

    // 🧹 تنظيف كاش المواعيد للعيادة بعد حجز ناجح
try {
  // 1) حذف كاش الجلب المسبق (Prefetch)
  const clinicKey = clinicCacheKey(clinic);
  await redis.del(clinicKey);

  // 2) حذف أي كاش مواعيد تفصيلي
  const scan = async (cursor = '0') => {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      `times:${clinic}*`,
      'COUNT',
      100
    );
    if (keys.length) await redis.del(keys);
    if (next !== '0') await scan(next);
  };
  await scan();

  console.log('[REDIS] cache cleared for clinic:', clinic);
} catch (e) {
  console.warn('[REDIS CLEANUP FAILED]', e?.message || e);
}

    // 🧹 حذف كاش المواعيد للعيادة بعد حجز ناجح
try {
  const clinicKey = clinicCacheKey(clinic);
  await redis.del(clinicKey);

  // حذف أي كاش جزئي مرتبط
  const pattern = `times:${normalizeClinicKey(clinic)}*`;

  const keys = await redis.keys(pattern);
  if (keys.length) await redis.del(keys);
} catch (e) {
  console.warn('[REDIS CLEANUP FAILED]', e?.message || e);
}

    
    // ✅ تسجيل حجز فعلي ناجح
incMetrics({ clinic });


    try { if (!WATCH) await page.close(); } catch(_){}
    
    return '✅ تم الحجز بنجاح (Booking Bot)';


  } catch (e) {

  // 🔓 فك القفل إذا فشل الحجز
  try {
    const [date, time24] = String(time).split('*');
    await unlockSlot(clinic, date, time24);
  } catch (_) {}

  try { if (!WATCH) await page.close(); } catch(_){}

  throw e; // ✅ مهم: لا ترجع نص فشل
}


}


/** =========================================================
 *                 Persistent Metrics (stats.json)
 * ========================================================= */
const METRICS_PATH = process.env.METRICS_PATH || path.join(__dirname, 'stats.json');
const STAFF_KEY = process.env.STAFF_KEY || '';

function ensureDir(p) {
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) { console.error('[metrics] ensureDir error:', e?.message || e); }
}
function safeReadJSON(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const txt = fs.readFileSync(p, 'utf8');
    return JSON.parse(txt);
  } catch (e) { console.error('[metrics] read error:', e?.message || e); return fallback; }
}
function safeWriteJSON(p, obj) {
  try {
    ensureDir(p);
    const tmp = p + '.tmp';
    const bak = p + '.bak';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    if (fs.existsSync(p)) fs.copyFileSync(p, bak);
    fs.renameSync(tmp, p);
  } catch (e) { console.error('[metrics] write error:', e?.message || e); }
}
function loadMetrics() {
  const init = { ok: true, total: 0, byClinic: {}, byDate: {}, byDateClinic: {} };
  const main = safeReadJSON(METRICS_PATH, null);
  if (main) return { ok: true, total: Number(main.total || 0), byClinic: main.byClinic || {}, byDate: main.byDate || {}, byDateClinic: main.byDateClinic || {} };
  const backup = safeReadJSON(METRICS_PATH + '.bak', null);
  if (backup) return { ok: true, total: Number(backup.total || 0), byClinic: backup.byClinic || {}, byDate: backup.byDate || {}, byDateClinic: backup.byDateClinic || {} };
  safeWriteJSON(METRICS_PATH, init);
  return init;
}
let METRICS = loadMetrics();
let _writing = false, _pendingWrite = false;
function saveMetrics() {
  if (_writing) { _pendingWrite = true; return; }
  _writing = true;
  try { safeWriteJSON(METRICS_PATH, METRICS); }
  finally { _writing = false; if (_pendingWrite) { _pendingWrite = false; saveMetrics(); } }
}
function todayKeyRiyadh() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date());
}
function incMetrics({ clinic }) {
  const dateKey = todayKeyRiyadh();
  METRICS.total = (Number(METRICS.total) || 0) + 1;
  const c = (clinic || '').trim() || 'غير محدد';
  METRICS.byClinic[c] = (Number(METRICS.byClinic[c]) || 0) + 1;
  METRICS.byDate[dateKey] = (Number(METRICS.byDate[dateKey]) || 0) + 1;
  METRICS.byDateClinic = METRICS.byDateClinic || {};
  const dayMap = METRICS.byDateClinic[dateKey] = METRICS.byDateClinic[dateKey] || {};
  dayMap[c] = (Number(dayMap[c]) || 0) + 1;
  saveMetrics();
}

app.post('/api/track-success', (req, res) => {
  try { incMetrics({ clinic: req.body?.clinic }); return res.json({ ok: true }); }
  catch (e) { console.error('/api/track-success', e?.message || e); return res.status(500).json({ ok: false, error: 'failed' }); }
});

app.get('/api/stats/summary', (req, res) => {
  const key = req.headers['x-staff-key'] || req.query.key || '';
  if (!STAFF_KEY || key !== STAFF_KEY) return res.status(403).json({ ok: false, error: 'Forbidden' });
  METRICS = loadMetrics();
  return res.json(METRICS);
});

app.post('/api/stats/reset', (req, res) => {
  const key = req.headers['x-staff-key'] || req.query.key || '';
  if (!STAFF_KEY || key !== STAFF_KEY) return res.status(403).json({ ok: false, error: 'Forbidden' });
  METRICS = { ok: true, total: 0, byClinic: {}, byDate: {}, byDateClinic: {} };
  saveMetrics();
  res.json({ ok: true });
});

/** ===== /api/open (headful viewer) ===== */
app.post('/api/open', async (req, res) => {
  if (!WATCH) {
    return res.status(400).json({ ok:false, message:'فعّل DEBUG_BROWSER=1 أو WATCH=1 أولاً' });
  }
  try {
    const browser = await getSharedBrowser();

    const page = await browser.newPage(); await prepPage(page);
    const acc = ACCOUNTS[0] || { user:'', pass:'' };
    await loginToImdad(page, acc);
    await gotoAppointments(page);
    return res.json({ ok:true, message:'المتصفح انفتح ووصل لصفحة المواعيد — شاهد الآن.' });
  } catch (e) {
    return res.status(500).json({ ok:false, message:'تعذّر فتح المشاهدة: ' + (e?.message || String(e)) });
  }
});

app.get('/health', (_req, res) => res.json({
  ok: true,
  time: new Date().toISOString(),
  chrome: CHROMIUM_PATH || 'bundled',
  baseCacheDir: BASE_DL_DIR,
  debug: DEBUG_BROWSER
}));

const PORT = process.env.PORT || 3000;
app.get('/health', async (req, res) => {
  try {
    await redis.ping();
    const browser = await getSharedBrowser();
    res.json({
      ok: true,
      redis: true,
      puppeteer: !!browser
    });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT} (watch=${WATCH})`);
});

// ===== Warmup Prefetch (Railway-safe) =====
// ===== Continuous PrefETCH Loop =====
async function prefetchLoop() {
  try {
    await prefetchAllClinicsTimes();
    console.log('[PREFETCH] cycle completed');
  } catch (e) {
    console.error('[PREFETCH] cycle error', e?.message);
  } finally {
    // ⏱️ بعد ما يخلص، يرجع يعيد الجلب
    setTimeout(prefetchLoop, 60 * 1000); // كل دقيقة
  }
}

// ⏳ أول تشغيل بعد الإقلاع
setTimeout(prefetchLoop, 5000);

