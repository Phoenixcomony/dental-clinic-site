// server.js
// ===============================
// Phoenix Clinic - Backend Server (Railway-ready, Headless by default)
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

/// بيئة آمنة للهيدلس
process.env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || '/tmp';
process.env.LANG = process.env.LANG || 'ar_SA.UTF-8';
process.env.PUPPETEER_CACHE_DIR = path.join(__dirname, '.puppeteer_cache');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));

// ===== Pretty Arabic Routes & SEO Redirects =====
const canonical = {
  'index.html':               ['الرئيسية', 'الرئيسيه'],
  'about.html':               ['من-نحن', 'نبذة'],
  'appointment.html':         ['حجز-موعد'],
  'contact.html':             ['اتصل-بنا'],
  'dental.html':              ['الأسنان', 'الاسنان'],
  'dermatology.html':         ['الجلدية-و-التجميل', 'الجلديه-و-التجميل'],
  'general-medicine.html':    ['الطب-العام', 'الطب-العام-والطوارئ'],
  'gynecology.html':          ['النساء-و-الولادة', 'النساء-و-الولادة'],
  'hydrafacial.html':         ['هايدرافيشل', 'تنظيف-البشرة-العميق'],
  'identity.html':            ['الهوية'],
  'laser-hair-removal.html':  ['إزالة-الشعر-بالليزر', 'الليزر'],
  'new-file.html':            ['فتح-ملف-جديد'],
  'services.html':            ['الخدمات'],
  'success.html':             ['تاكيد-الحجز'],
};

// 1) SEO 301
for (const [file, slugs] of Object.entries(canonical)) {
  const target = `/${slugs[0]}`;
  app.get(`/${file}`, (req, res) => res.redirect(301, target));
}

// 2) ملفات المسارات العربية
app.get('*', (req, res, next) => {
  let p = req.path;
  try { p = decodeURIComponent(p); } catch (_) {}
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  for (const [file, slugs] of Object.entries(canonical)) {
    for (const slug of slugs) {
      if (p === `/${slug}`) return res.sendFile(path.join(__dirname, file));
    }
  }
  next();
});

// 3) الجذر
app.get('/', (req, res) => res.redirect(302, `/${canonical['index.html'][0]}`));
app.use(express.static(__dirname));

/** ===== ENV ===== */
const INSTANCE_ID = process.env.INSTANCE_ID || 'CHANGE_ME';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || 'CHANGE_ME';
const SKIP_OTP_FOR_TESTING = process.env.SKIP_OTP_FOR_TESTING === 'true';
const DEBUG_BROWSER = process.env.DEBUG_BROWSER === '1';
const PUPPETEER_PROTOCOL_TIMEOUT_MS = Number(process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS || 180000);

/** ===== Watch / Headful Mode ===== */
const WATCH = DEBUG_BROWSER || (process.env.WATCH === '1');

/** ===== Chromium path detection ===== */
const BASE_DL_DIR =
  process.env.PUPPETEER_DOWNLOAD_PATH ||
  process.env.PUPPETEER_CACHE_DIR ||
  '/app/.cache/puppeteer';

function findChromeUnder(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return null;
    const channelDirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    const stacks = [
      { root: 'chrome', sub: ['linux-', 'chrome-linux64', 'chrome'] },
      { root: 'chrome-headless-shell', sub: ['linux-', 'chrome-headless-shell-linux64', 'chrome-headless-shell'] },
      { root: 'chromium', sub: ['linux-', 'chrome-linux64', 'chrome'] }
    ];

    for (const s of stacks) {
      const matchRoot = channelDirs.find(n => n.startsWith(s.root));
      if (!matchRoot) continue;
      const lvl1 = path.join(dir, matchRoot);
      const linuxReleases = fs.readdirSync(lvl1, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.startsWith('linux-'))
        .map(d => d.name)
        .sort((a, b) => b.localeCompare(a));
      for (const rel of linuxReleases) {
        const candidate = path.join(lvl1, rel, s.sub[1], s.sub[2]);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch (_) {}
  return null;
}

const CANDIDATE_PATHS = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable'
].filter(Boolean);

function resolveChromePath() {
  for (const p of CANDIDATE_PATHS) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  const found = findChromeUnder(BASE_DL_DIR);
  if (found) return found;
  return null;
}

const CHROMIUM_PATH = resolveChromePath();
console.log('Using Chromium path:', CHROMIUM_PATH || '(bundled by puppeteer)');

/** ===== Imdad accounts ===== */
const ACCOUNTS = [
  { user: "1111111111", pass: "1111111111", busy: false },
  { user: "2222222222", pass: "2222222222", busy: false },
  { user: "3333333333", pass: "3333333333", busy: false },
  { user: "5555555555", pass: "5555555555", busy: false },
  { user: "4444444444", pass: "4444444444", busy: false },
  { user: "6666666666", pass: "6666666666", busy: false },
  { user: "7777777777", pass: "7777777777", busy: false },
  { user: "8888888888", pass: "8888888888", busy: false },
  { user: "9999999999", pass: "9999999999", busy: false },
  { user: "1010101010", pass: "1010101010", busy: false },
];

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

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
    headless: false, // 👈 ضروري جدًا لتعمل fillSearch120 بشكل طبيعي
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

  const pagePhone = await page.evaluate(() => {
    function toAscii(s){
      const map={'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'};
      return String(s).replace(/[٠-٩]/g, d=>map[d]||d);
    }
    const td = Array.from(document.querySelectorAll('td[height="29"]'))
      .map(x => toAscii((x.textContent || '').trim()))
      .find(v => /^05\d{8}$/.test(v));
    return td || '';
  });

  if (pagePhone && expectedPhone05) {
    const cleanExpected = expectedPhone05.replace(/\D/g,'');
    if (pagePhone.endsWith(cleanExpected.slice(-4))) {
      console.log('[IMDAD] ✅ الجوال متطابق');
      return { ok:true, fileId, liPhone: pagePhone };
    } else {
      console.warn('[IMDAD] ⚠️ الجوال غير متطابق');
      return { ok:false, reason:'phone_mismatch', found: pagePhone };
    }
  } else {
    return { ok:false, reason:'phone_not_found' };
  }
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

app.post('/send-otp', async (req, res) => {
  try {
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
    await axios.get(url, { timeout: 15015 });

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

/** ===== /api/login ===== */
app.post('/api/login', async (req, res) => {
  try {
    const { identity, phone, otp } = req.body || {};
    const idDigits = toAsciiDigits(identity||'').replace(/\D/g,'');
    if(!isLikelyIdentity(idDigits)) return res.status(200).json({ success:false, message:'اكتب رقم الهوية/الإقامة بشكل صحيح' });
    if(!isSaudi05(phone))  return res.status(200).json({ success:false, message:'رقم الجوال بصيغة 05xxxxxxxx' });
    if(!verifyOtpInline(phone, otp)) return res.status(200).json({ success:false, message:'رمز التحقق غير صحيح', reason:'otp' });

    const browser = await launchBrowserSafe();
    const page = await browser.newPage(); await prepPage(page);

    let account=null;
    try{
      account = await acquireAccount();
      await loginToImdad(page, account);

      const phone05 = toLocal05(phone);
      const searchRes = await searchAndOpenPatientByIdentity(page, {
        identityDigits: idDigits,
        expectedPhone05: phone05
      });
      await triggerSuggestions(page, '#navbar-search-input, input[name="name122"]');

      if(!searchRes.ok){
        console.log('[IMDAD] login-by-id result:', searchRes);
        try { if (!WATCH) await browser.close(); } catch(_){}
        if(account) releaseAccount(account);
        if (searchRes.reason === 'phone_mismatch') {
          return res.json({ success:false, exists:true, reason:'phone_mismatch', message:'رقم الجوال غير متطابق مع الهوية' });
        }
        return res.json({ success:false, exists:false, message:'لا تملك ملفًا لدينا. انقر (افتح ملف جديد).' });
      }

      const fileId = searchRes.fileId;
      const liPhone = searchRes.liPhone;

      if (liPhone) {
        if (!phonesEqual05(liPhone, phone)) {
          try { if (!WATCH) await browser.close(); } catch(_){}
          if(account) releaseAccount(account);
          return res.json({ success:false, exists:true, reason:'phone_mismatch', message:'رقم الجوال غير متطابق مع الهوية' });
        }
      } else {
        console.log('[IMDAD] patient has no phone on file; accepting identity match.');
      }

      const idStatus = await readIdentityStatus(page, fileId);

      try { if (!WATCH) await browser.close(); } catch(_){}
      if(account) releaseAccount(account);

      return res.json({
        success:true,
        exists:true,
        fileId,
        hasIdentity: idStatus.hasIdentity,
        pickedText: searchRes.pickedText
      });
    }catch(e){
      console.error('[IMDAD] /api/login error:', e?.message||e);
      try{ if (!WATCH) await browser.close(); }catch(_){}
      if(account) releaseAccount(account);
      return res.status(200).json({ success:false, message:'تعذّر التحقق حاليًا. حاول لاحقًا.' });
    }
  } catch (e) {
    console.error('/api/login fatal', e?.message||e);
    return res.status(200).json({ success:false, message:'تعذّر التحقق حاليًا. حاول لاحقًا.' });
  }
});

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

/** ===== /api/update-identity ===== */
app.post('/api/update-identity', async (req, res) => {
  try{
    const { fileId, nationalId, birthYear } = req.body || {};
    if(!fileId) return res.json({ success:false, message:'رقم الملف مفقود' });
    if(!nationalId) return res.json({ success:false, message:'رقم الهوية مطلوب' });
    if(!birthYear) return res.json({ success:false, message:'سنة الميلاد مطلوبة' });

    const browser = await launchBrowserSafe();
    const page = await browser.newPage(); await prepPage(page);

    let account=null;
    try{
      account = await acquireAccount();
      await loginToImdad(page, account);

      await page.goto(`https://phoenix.imdad.cloud/medica13/stq_edit.php?id=${fileId}`, { waitUntil:'domcontentloaded' });

      await page.waitForSelector('#ssn', { timeout: 20000 });
      await page.$eval('#ssn', (el,v)=>{ el.value=v; }, String(nationalId));
      await page.select('#year12', String(birthYear));

      await page.waitForSelector('#submit', { timeout: 20000 });
      await page.evaluate(() => {
        const btn = document.querySelector('#submit');
        if (btn) { btn.disabled=false; btn.removeAttribute('disabled'); btn.click(); }
      });

      await sleep(1500);
      try { if (!WATCH) await browser.close(); }catch(_){}
      if(account) releaseAccount(account);
      return res.json({ success:true, message:'تم التحديث بنجاح' });
    }catch(e){
      console.error('/api/update-identity error', e?.message||e);
      try{ if (!WATCH) await browser.close(); }catch(_){}
      if(account) releaseAccount(account);
      return res.json({ success:false, message:'فشل التحديث: ' + (e?.message||e) });
    }
  }catch(e){
    return res.json({ success:false, message:'خطأ غير متوقع' });
  }
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
      const browser = await launchBrowserSafe();
      const page = await browser.newPage(); await prepPage(page);
      page.on('dialog', async d => { try { await d.accept(); } catch(_) {} });

      let account=null;
      try{
        account = await acquireAccountWithTimeout(20000);
        await loginToImdad(page, account);

        if (await existsPatientByPhone(page, phone05)) {
          try { if (!WATCH) await browser.close(); } catch(_){}
          if(account) releaseAccount(account);
          return res.json({
            success:false,
            reason:'phone_exists',
            message:'لديك ملف مسجل لدينا، الرجاء تسجيل الدخول'
          });
        }

        const opened = await openNewFilePage(page);
        if (!opened) {
          try { if (!WATCH) await browser.close(); } catch(_){}
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
          try { if (!WATCH) await browser.close(); } catch(_){}
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
          try { if (!WATCH) await browser.close(); } catch(_){}
          if(account) releaseAccount(account);
          return res.json({
            success:false,
            reason:'phone_exists',
            message:'لديك ملف مسجل لدينا، الرجاء تسجيل الدخول'
          });
        }

        try { if (!WATCH) await browser.close(); } catch(_){}
        if(account) releaseAccount(account);
        return res.json({ success:true, message:'تم إنشاء الملف بنجاح' });

      }catch(e){
        console.error('/api/create-patient error', e?.message||e);
        try{ if (!WATCH) await browser.close(); }catch(_){}
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

/** ===== /api/times ===== */
app.post('/api/times', async (req, res) => {
  try {
    const { clinic, month, period } = req.body || {};
    if (!clinic || !month) return res.status(400).json({ times: [], error: 'العيادة أو الشهر مفقود' });

    const clinicStr = String(clinic || '');

    // تحديد الفترة تلقائيًا من اسم العيادة
    const autoPeriod =
      /\*\*الفترة الثانية$/.test(clinicStr) ? 'evening' :
      (/\*\*الفترة الاولى$/.test(clinicStr) ? 'morning' : null);
    const effectivePeriod = period || autoPeriod;

    // اسم العيادة بدون الجزء الخاص بالفترة (قبل **)
    const baseClinicName = clinicStr.split('**')[0].trim();
    const asciiClinic    = toAsciiDigits(baseClinicName);

    // عيادات خاصة نحتاج نميّزها
    const isCleaningDerm = baseClinicName.includes('تشقير') && baseClinicName.includes('تنظيف');

    // الجلدية والتجميل الفترة الثانية (هي اللي نحجب عنها الجمعة)
    const DERM_EVENING_VALUE = 'عيادة الجلدية والتجميل (NO.200)**الفترة الثانية';
    const isDermEvening      = (clinicStr === DERM_EVENING_VALUE);

    // عيادة الأسنان 1 الفترة الثانية
    const isDental1Evening =
      clinicStr.includes('عيادة الاسنان 1') ||
      clinicStr.includes('عيادة الأسنان 1');

    // عيادة الأسنان 4 الفترة الثانية
    const isDental4Evening =
      clinicStr.includes('عيادة الاسنان 4') ||
      clinicStr.includes('عيادة الأسنان 4');

    // حجب الجمعة فقط لعيادة الجلدية والتجميل الفترة الثانية
    const shouldBlockFriday = isDermEvening;

    const timeToMinutes = (t) => {
      if (!t) return NaN;
      const [H, M = '0'] = t.split(':');
      return (+H) * 60 + (+M);
    };

    const to12h = (t) => {
      if (!t) return '';
      let [H, M = '0'] = t.split(':');
      H = +H;
      M = String(+M).padStart(2, '0');
      const am = H < 12;
      let h = H % 12;
      if (h === 0) h = 12;
      return `${h}:${M} ${am ? 'ص' : 'م'}`;
    };

    // الفترة الصباحية (حاليًا: نساء وولادة 10:00–11:30 ص)
    const inMorning = (t) => {
      const m = timeToMinutes(t);
      return m >= 10 * 60 && m <= 11 * 60 + 30;
    };

    // الفترة المسائية (منطق خاص لكل عيادة)
    const inEvening = (t) => {
      const m = timeToMinutes(t);

      // 1) تشقير وتنظيف البشرة: 4:00–9:00م
      if (isCleaningDerm) {
        return m >= 16 * 60 && m <= 21 * 60;
      }

      // 2) الجلدية والتجميل (NO.200)**الفترة الثانية: 3:00–8:30م
      if (isDermEvening) {
        return m >= 15 * 60 && m <= 20 * 60 + 30;
      }

      // 3) عيادة الأسنان 1 الفترة الثانية: 4:00–8:30م
      if (isDental1Evening) {
        return m >= 16 * 60 && m <= 20 * 60 + 30;
      }

      // 4) عيادة الأسنان 4 الفترة الثانية: 2:00–9:30م
      if (isDental4Evening) {
        return m >= 14 * 60 && m <= 21 * 60 + 30;
      }

      // 5) الافتراضي لباقي العيادات المسائية (مثل عيادة الأسنان 5…)
      return m >= 12 * 60 && m <= 21 * 60 + 30;
    };

    const browser = await launchBrowserSafe();
    const page = await browser.newPage(); await prepPage(page);

    try {
      // نستخدم أول حساب فقط لقراءة المواعيد
      await loginToImdad(page, { user: '1111111111', pass: '1111111111' });
      await gotoAppointments(page);

      // اختيار العيادة
      const clinicValue = await page.evaluate((name) => {
        const opts = Array.from(document.querySelectorAll('#clinic_id option'));
        const f = opts.find(o =>
          (o.textContent || '').trim() === name ||
          (o.value || '') === name
        );
        return f ? f.value : null;
      }, clinic);
      if (!clinicValue) throw new Error('لم يتم العثور على العيادة!');

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {}),
        page.select('#clinic_id', clinicValue)
      ]);

      // عرض شهر واحد
      await applyOneMonthView(page);

      // اختيار الشهر المطلوب
      const pickedMonth = await page.evaluate((wanted) => {
        const sel = document.querySelector('#month1');
        if (!sel) return null;
        const w = String(wanted).trim();
        const opts = Array.from(sel.options || []).map(o => ({
          value: o.value || '',
          text: (o.textContent || '').trim()
        }));
        const hit =
          opts.find(o => o.text === w) ||
          opts.find(o => o.value.includes(`month=${w}`)) ||
          opts.find(o => o.text.endsWith(w)) ||
          null;
        if (!hit) return null;
        try { sel.value = hit.value; sel.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
        try { if (hit.value) window.location.href = hit.value; } catch (_) {}
        return hit.value;
      }, month);

      if (!pickedMonth) throw new Error('month_not_found');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});

      // قراءة كل المواعيد المتاحة (راديو غير معطّل)
      const raw = await page.evaluate(() => {
        const out = [];
        const radios = document.querySelectorAll('input[type="radio"][name="ss"]:not(:disabled)');
        for (const r of radios) {
          const value = r.value || '';
          const [date, time24] = value.split('*');
          out.push({
            value,
            date: (date || '').trim(),
            time24: (time24 || '').trim()
          });
        }
        return out;
      });

      let filtered = raw;

      // تطبيق فلترة الفترة (صباحية / مسائية)
      if (effectivePeriod === 'morning') {
        filtered = raw.filter(x => x.time24 && inMorning(x.time24));
      }
      if (effectivePeriod === 'evening') {
        filtered = raw.filter(x => x.time24 && inEvening(x.time24));
      }

      // حجب الجمعة فقط للجلدية والتجميل الفترة الثانية
      if (shouldBlockFriday) {
        const isFriday = (dateStr) => {
          // التاريخ مثل: 14-11-2025 (يوم-شهر-سنة)
          const [D, M, Y] = (dateStr || '').split('-').map(n => +n);
          if (!Y || !M || !D) return false;
          const wd = new Date(Date.UTC(Y, M - 1, D)).getUTCDay(); // 5 = الجمعة
          return wd === 5;
        };
        filtered = filtered.filter(x => !isFriday(x.date));
      }

      // عيادة "تشقير وتنظيف البشرة**الفترة الثانية" — تجميع بالساعة
      if (isCleaningDerm) {
        const buckets = new Map(); // key = date|H
        for (const x of filtered) {
          if (!x.time24) continue;
          const [H] = x.time24.split(':').map(n => +n);
          const key = `${x.date}|${H}`;
          if (!buckets.has(key)) buckets.set(key, x); // أول خانة داخل الساعة
        }
        const to12hHour = (H) => {
          const am = H < 12; let h = H % 12; if (h === 0) h = 12;
          return `${h}:00 ${am ? 'ص' : 'م'}`;
        };
        const hourly = [];
        for (const [key, firstSlot] of buckets.entries()) {
          const [date, Hstr] = key.split('|'); const H = +Hstr || 0;
          hourly.push({ value: firstSlot.value, label: `${date} - ${to12hHour(H)}` });
        }
        hourly.sort((a, b) => a.label.localeCompare(b.label, 'ar'));
        try { if (!WATCH) await browser.close(); } catch (_) {}
        return res.json({ times: hourly });
      }

      // الشكل النهائي للأوقات لباقي العيادات
      const times = filtered.map(x => ({
        value: x.value,
        label: `${x.date} - ${to12h(x.time24)}`
      }));

      try { if (!WATCH) await browser.close(); } catch (_) {}
      res.json({ times });

    } catch (e) {
      try { if (!WATCH) await browser.close(); } catch (_) {}
      res.json({ times: [], error: e?.message || String(e) });
    }
  } catch (e) {
    res.json({ times: [], error: e?.message || String(e) });
  }
});

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
const bookingQueue = [];
let processingBooking = false;

app.post('/api/book', async (req, res) => {
  bookingQueue.push({ req, res });
  processQueue();
});

async function processQueue() {
  if (processingBooking || !bookingQueue.length) return;
  processingBooking = true;

  const { req, res } = bookingQueue.shift();
  try {
    const msg = await bookNow({ ...req.body });
    res.json({ msg });
  } catch (e) {
    res.json({ msg: '❌ فشل الحجز! ' + (e?.message || String(e)) });
  } finally {
    processingBooking = false;
    processQueue();
  }
}


/// ===== Booking flow (single) — V2 =====
async function bookNow({ identity, name, phone, clinic, month, time, note }) {
  const browser = await launchBrowserSafe();
  const page = await browser.newPage();
  await prepPage(page);

  let account = null;
  const delay = (ms=700)=>new Promise(r=>setTimeout(r,ms));

  try {
    account = await acquireAccount();
    await loginToImdad(page, account);

    await gotoAppointments(page);
    await delay();

    const clinicValue = await page.evaluate((wanted) => {
      const opts = Array.from(document.querySelectorAll('#clinic_id option'));
      const hit = opts.find(o => (o.textContent||'').trim() === wanted || (o.value||'') === wanted);
      return hit ? hit.value : null;
    }, String(clinic||'').trim());
    if (!clinicValue) throw new Error('لم يتم العثور على العيادة!');

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

    await selectPatientOnAppointments(page, String(identity||'').trim());
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
    if (!picked) throw new Error('لم يتم العثور على الموعد المطلوب!');

    await delay(600);
    await clickReserveAndConfirm(page);

    try { if (!WATCH) await browser.close(); } catch(_){}
    if (account) releaseAccount(account);
    return '✅ تم الحجز بنجاح بالحساب: ' + account.user;

  } catch (e) {
    try { if (!WATCH) await browser.close(); } catch(_){}
    if (account) releaseAccount(account);
    return '❌ فشل الحجز: ' + (e?.message || 'حدث خطأ غير متوقع');
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
    const browser = await launchBrowserSafe();
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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT} (watch=${WATCH})`);
});




