// server.js
// ===============================
// Phoenix Clinic - Backend Server (Railway-ready, Headless-hardened)
// ===============================

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

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));
app.use(express.static(__dirname));

/** ===== ENV =====
 * INSTANCE_ID / ACCESS_TOKEN: mywhats.cloud credentials
 * SKIP_OTP_FOR_TESTING=true لتجاوز OTP في التطوير
 * DEBUG_BROWSER=1 لفتح المتصفح (لمراقبة البوت)، و 0 أو غير مهيأ لتشغيله مخفيًا
 */
const INSTANCE_ID = process.env.INSTANCE_ID || 'CHANGE_ME';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || 'CHANGE_ME';
const SKIP_OTP_FOR_TESTING = process.env.SKIP_OTP_FOR_TESTING === 'true';
const DEBUG_BROWSER = process.env.DEBUG_BROWSER === '1'; // الافتراضي مخفي
const PUPPETEER_PROTOCOL_TIMEOUT_MS = Number(process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS || 180000); // 3 دقائق

/** ===== Chromium path detection (Railway-friendly) ===== */
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
        .sort((a, b) => b.localeCompare(a)); // اختر الأحدث
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
  return null; // استخدم النسخة المضمّنة لو موجودة
}

const CHROMIUM_PATH = resolveChromePath();
console.log('Using Chromium path:', CHROMIUM_PATH || '(bundled by puppeteer)');

/** ===== Imdad accounts (rotating) ===== */
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

// ===== Imdad accounts helpers
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

/** ===== Helpers (hardened) ===== */
function normalizeArabic(s=''){ return (s||'').replace(/\s+/g,' ').trim(); }
function toAsciiDigits(s='') {
  const map = {'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'};
  return String(s).replace(/[٠-٩]/g, d => map[d] || d);
}
function isTripleName(n){ return normalizeArabic(n).split(' ').filter(Boolean).length === 3; }
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
  let ok = true;
  for (const w of t) { if (!c.has(w)) { ok=false; break; } }
  if (ok) return true;
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

/** ===== Puppeteer launch (headless-hardened) ===== */
function launchOpts(){
  const exe = CHROMIUM_PATH || undefined;
  return {
    executablePath: exe,
    headless: 'new',
    ignoreHTTPSErrors: true,
    devtools: false,
    slowMo: 0,
    protocolTimeout: PUPPETEER_PROTOCOL_TIMEOUT_MS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--use-gl=swiftshader',
      '--use-angle=swiftshader',
      '--window-size=1280,900',
      '--lang=ar-SA,ar,en-US,en',
      '--disable-features=IsolateOrigins,site-per-process,UseOzonePlatform,VizDisplayCompositor,Translate,BackForwardCache,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion,AcceptCHFrame'
    ]
  };
}

async function launchBrowserSafe() {
  try {
    return await puppeteer.launch(launchOpts());
  } catch (e) {
    try {
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
    } catch (e2) {
      throw e2;
    }
  }
}

async function prepPage(page){
  await page.setViewport({ width: 1280, height: 900 });
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(120000);
  await page.setExtraHTTPHeaders({ 'Accept-Language':'ar-SA,ar;q=0.9,en;q=0.8' });
  await page.emulateTimezone('Asia/Riyadh').catch(()=>{});
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36');
}

/** ===== Login (hardened with retry) ===== */
async function loginToImdad(page, {user, pass}){
  console.log('[IMDAD] opening login…');
  await page.goto('https://phoenix.imdad.cloud/medica13/login.php?a=1', { waitUntil: 'domcontentloaded' });

  await page.waitForSelector('input[name="username"]', { timeout: 30000 });
  await page.$eval('input[name="username"]', (el,v)=>{el.value=v;}, user);
  await page.$eval('input[name="password"]', (el,v)=>{el.value=v;}, pass);

  await Promise.race([
    page.waitForNavigation({waitUntil:'domcontentloaded', timeout: 30000}),
    page.click('#submit')
  ]).catch(()=>{});

  let ok = await page.waitForSelector('#navbar-search-input, a[href*="appoint_display.php"]', { timeout: 15000 })
    .then(()=>true).catch(()=>false);

  if (!ok) {
    console.warn('[IMDAD] login retry…');
    await page.goto('https://phoenix.imdad.cloud/medica13/login.php?a=1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[name="username"]', { timeout: 30000 });
    await page.$eval('input[name="username"]', (el,v)=>{el.value=v;}, user);
    await page.$eval('input[name="password"]', (el,v)=>{el.value=v;}, pass);
    await Promise.race([
      page.waitForNavigation({waitUntil:'domcontentloaded', timeout: 30000}),
      page.click('#submit')
    ]).catch(()=>{});
    ok = await page.waitForSelector('#navbar-search-input, a[href*="appoint_display.php"]', { timeout: 15000 })
      .then(()=>true).catch(()=>false);
    if (!ok) throw new Error('login_failed');
  }

  console.log('[IMDAD] logged in.');
}

async function gotoAppointments(page){
  console.log('[IMDAD] goto appointments…');
  await page.goto('https://phoenix.imdad.cloud/medica13/appoint_display.php', { waitUntil:'domcontentloaded' });
}

/** ===== Utilities used by multiple bots ===== */
async function typeSlow(page, selector, text, perCharDelay = 140) {
  await page.waitForSelector(selector, { visible: true, timeout: 30000 });
  await page.focus(selector);
  await page.$eval(selector, el => { el.value = ''; });
  for (const ch of text) {
    await page.type(selector, ch, { delay: perCharDelay });
  }
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

async function pickFirstSuggestionOnAppointments(page, timeoutMs = 10000) {
  const start = Date.now();
  let picked = false;
  while (Date.now() - start < timeoutMs) {
    const ok = await page.evaluate(() => {
      const li = document.querySelector('li[onclick^="fillSearch120"], .searchsugg120 li');
      if (li) { li.click(); return true; }
      return false;
    });
    if (ok) { picked = true; break; }
    await page.evaluate(() => {
      const el = document.querySelector('#SearchBox120');
      if (el) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
      }
    });
    await sleep(300);
  }
  return picked;
}

/** ===== Open New-File page robustly ===== */
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

/** ===== Search helpers ===== */
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
      if (el) {
        ['input','keyup','keydown','change'].forEach(ev=> el.dispatchEvent(new Event(ev, { bubbles: true })));
      }
    });
    await sleep(300);
  }
  return items.map(it => ({ ...it, parsed: parseSuggestionText(it.text) }));
}

/** ===== High-level search + open by best match ===== */
async function searchAndOpenPatient(page, { fullName, expectedPhone05 }) {
  let items = await searchSuggestionsByName(page, fullName);

  let chosen = null;
  if (expectedPhone05) {
    const withPhone = items.find(it => phonesEqual05(it.parsed.phone, expectedPhone05));
    if (withPhone) chosen = withPhone;
  }
  if (!chosen && items.length) {
    const exact = items.find(it => normalizeArabic(it.parsed.name) === normalizeArabic(fullName));
    if (exact) chosen = exact;
  }
  if (!chosen && items.length) {
    const similar = items.find(it => nameSimilar(fullName, it.parsed.name));
    if (similar) chosen = similar;
  }
  if (!chosen && expectedPhone05) {
    items = await searchSuggestionsByPhoneOnNavbar(page, expectedPhone05);
    const byPhone = items.find(it => phonesEqual05(it.parsed.phone, expectedPhone05));
    if (byPhone) chosen = byPhone;
  }
  if (!chosen && expectedPhone05) {
    items = await searchSuggestionsByPhoneOnAppointments(page, expectedPhone05);
    const byPhone = items.find(it => phonesEqual05(it.parsed.phone, expectedPhone05));
    if (byPhone) chosen = byPhone;
  }

  if (!chosen) return { ok:false, reason:'no_suggestions' };

  await page.evaluate((idx)=>{
    const lis = document.querySelectorAll('li[onclick^="fillSearch12"], li[onclick^="fillSearch120"], .searchsugg120 li');
    if(lis && lis[idx]) lis[idx].click();
  }, chosen.idx);

  const patientHref = await page.evaluate(()=>{
    const a1 = document.querySelector('a[href^="stq_search2.php?id="]');
    if (a1) return a1.getAttribute('href');
    const icon = document.querySelector('a i.far.fa-address-card');
    if (icon && icon.closest('a')) return icon.closest('a').getAttribute('href');
    return '';
  });

  if (!patientHref) return { ok:false, reason:'no_patient_link', pickedText: chosen.text, ...chosen.parsed };

  const fileId = chosen.parsed.fileId || ((patientHref.match(/id=(\d+)/) || [])[1] || '');
  await page.goto(`https://phoenix.imdad.cloud/medica13/${patientHref}`, { waitUntil: 'domcontentloaded' });

  let liPhone = chosen.parsed.phone || '';
  if (!liPhone) {
    try {
      liPhone = await page.evaluate(()=>{
        function toAscii(s){const map={'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'};return String(s).replace(/[٠-٩]/g, d=>map[d]||d);}
        const tds = Array.from(document.querySelectorAll('td[height="29"]'));
        for(const td of tds){
          const val = (td.textContent||'').trim();
          const digits = toAscii(val).replace(/[^\d]/g,'');
          if(/^05\d{8}$/.test(digits)) return digits;
        }
        return '';
      });
    } catch {}
  }

  return { ok:true, pickedText: chosen.text, fileId, liPhone, liName: chosen.parsed.name };
}

/** ===== Duplicate-phone detector ===== */
async function isDuplicatePhoneWarning(page){
  try {
    const found = await page.evaluate(()=>{
      const txt = (document.body.innerText||'').replace(/\s+/g,' ');
      return /رقم هاتف موجود يخص المريض\s*:|رقم الجوال موجود|Existing phone number|Phone number already exists/i.test(txt);
    });
    return !!found;
  } catch {
    return false;
  }
}

/** ===== Pre-check by phone ===== */
async function existsPatientByPhone(page, phone05){
  let items = await searchSuggestionsByPhoneOnNavbar(page, phone05);
  if (items.some(it => phonesEqual05(it.parsed.phone, phone05))) return true;

  items = await searchSuggestionsByPhoneOnAppointments(page, phone05);
  if (items.some(it => phonesEqual05(it.parsed.phone, phone05))) return true;

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
      return res.status(429).json({ success:false, message:`أعد المحاولة بعد ${60-diff} ثانية` , retryAfter: 60-diff });
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
    await axios.get(url, { timeout: 15000 });

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
    const { name, phone, otp } = req.body || {};
    if(!isTripleName(name)) return res.status(200).json({ success:false, message:'الاسم يجب أن يكون ثلاثيًا' });
    if(!isSaudi05(phone))  return res.status(200).json({ success:false, message:'رقم الجوال بصيغة 05xxxxxxxx' });
    if(!verifyOtpInline(phone, otp)) return res.status(200).json({ success:false, message:'رمز التحقق غير صحيح', reason:'otp' });

    const browser = await launchBrowserSafe();
    const page = await browser.newPage(); await prepPage(page);
    let account=null;
    try{
      account = await acquireAccount();
      await loginToImdad(page, account);

      const phone05 = toLocal05(phone);
      const searchRes = await searchAndOpenPatient(page, {
        fullName: normalizeArabic(name),
        expectedPhone05: phone05
      });

      if(!searchRes.ok){
        console.log('[IMDAD] search result:', searchRes);
        await browser.close(); if(account) releaseAccount(account);
        return res.json({ success:false, exists:false, message:'لا تملك ملفًا لدينا. انقر (افتح ملف جديد).' });
      }

      const fileId = searchRes.fileId;
      const liPhone = searchRes.liPhone;

      if (liPhone) {
        if (!phonesEqual05(liPhone, phone)) {
          await browser.close(); if(account) releaseAccount(account);
          return res.json({ success:false, exists:true, reason:'phone_mismatch', message:'رقم الجوال غير متطابق مع الاسم' });
        }
      } else {
        console.log('[IMDAD] patient has no phone on file; accepting name match.');
      }

      const idStatus = await readIdentityStatus(page, fileId);

      await browser.close(); if(account) releaseAccount(account);

      return res.json({
        success:true,
        exists:true,
        fileId,
        fullName: normalizeArabic(name),
        hasIdentity: idStatus.hasIdentity,
        matchedText: searchRes.pickedText
      });
    }catch(e){
      console.error('[IMDAD] /api/login error:', e?.message||e);
      try{ await browser.close(); }catch(_){}
      if(account) releaseAccount(account);
      return res.status(200).json({ success:false, message:'تعذّر التحقق حاليًا. حاول لاحقًا.' });
    }
  } catch (e) {
    console.error('/api/login fatal', e?.message||e);
    return res.status(200).json({ success:false, message:'تعذّر التحقق حاليًا. حاول لاحقًا.' });
  }
});

/** ===== Read identity (SSN) ===== */
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

      await page.waitForSelector('#ssn', { timeout: 12000 });
      await page.$eval('#ssn', (el,v)=>{ el.value=v; }, String(nationalId));
      await page.select('#year12', String(birthYear));

      await page.waitForSelector('#submit', { timeout: 20000 });
      await page.evaluate(() => {
        const btn = document.querySelector('#submit');
        if (btn) { btn.disabled=false; btn.removeAttribute('disabled'); btn.click(); }
      });

      await sleep(1500);
      await browser.close(); if(account) releaseAccount(account);
      return res.json({ success:true, message:'تم التحديث بنجاح' });
    }catch(e){
      console.error('/api/update-identity error', e?.message||e);
      try{ await browser.close(); }catch(_){}
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
          await browser.close(); if(account) releaseAccount(account);
          return res.json({
            success:false,
            reason:'phone_exists',
            message:'لديك ملف مسجل لدينا، الرجاء تسجيل الدخول'
          });
        }

        const opened = await openNewFilePage(page);
        if (!opened) {
          await browser.close(); if(account) releaseAccount(account);
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
          await browser.close(); if(account) releaseAccount(account);
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
          await browser.close(); if(account) releaseAccount(account);
          return res.json({
            success:false,
            reason:'phone_exists',
            message:'لديك ملف مسجل لدينا، الرجاء تسجيل الدخول'
          });
        }

        await browser.close(); if(account) releaseAccount(account);
        return res.json({ success:true, message:'تم إنشاء الملف بنجاح' });

      }catch(e){
        console.error('/api/create-patient error', e?.message||e);
        try{ await browser.close(); }catch(_){}
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

/** ===== Helper: تطبيق "1 month" قبل اختيار الشهر ===== */
async function applyOneMonthView(page){
  // تحاول إيجاد أي select يحوي خيار 1 month أو قيمة day_no=30
  const didSet = await page.evaluate(()=>{
    const selects = Array.from(document.querySelectorAll('select'));
    for (const sel of selects) {
      const opts = Array.from(sel.options || []);
      const opt = opts.find(o => (o.textContent||'').trim().toLowerCase() === '1 month')
              || opts.find(o => String(o.value||'').includes('day_no=30'));
      if (opt) {
        try {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles:true }));
          // إن كانت القيمة رابطًا ل appoint_display.php فنفّذ انتقالًا صريحًا
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
    // امنح الصفحة فرصة للتنقل أو إعادة التحميل
    await page.waitForNavigation({waitUntil:'domcontentloaded', timeout:120000}).catch(()=>{});
  }
  return didSet;
}

/** ===== /api/times ===== */
app.post('/api/times', async (req, res) => {
  try {
    const { clinic, month } = req.body || {};
    if (!clinic || !month) return res.status(400).json({ times: [], error: 'العيادة أو الشهر مفقود' });

    const browser = await launchBrowserSafe();
    const page = await browser.newPage(); await prepPage(page);
    try{
      await loginToImdad(page, { user:'1111111111', pass:'1111111111' });
      await gotoAppointments(page);

      const clinicValue = await page.evaluate((name) => {
        const opts = Array.from(document.querySelectorAll('#clinic_id option'));
        const f = opts.find(o => (o.textContent||'').trim() === name);
        return f ? f.value : null;
      }, clinic);
      if(!clinicValue) throw new Error('لم يتم العثور على العيادة!');

      await Promise.all([
        page.waitForNavigation({waitUntil:'domcontentloaded', timeout:120000}),
        page.select('#clinic_id', clinicValue)
      ]);

      // ✅ طبّق "1 month" قبل اختيار الشهر
      await applyOneMonthView(page);

      const months = await page.evaluate(()=>Array.from(document.querySelectorAll('#month1 option')).map(o=>({value:o.value,text:o.textContent})));
      const monthValue = months.find(m => m.text === month || m.value === month)?.value;
      if(!monthValue) throw new Error('لم يتم العثور على الشهر المطلوب!');

      await Promise.all([
        page.waitForNavigation({waitUntil:'domcontentloaded', timeout:120000}),
        page.select('#month1', monthValue)
      ]);

      const times = await page.evaluate(()=>{
        function p(t){ if(!t) return ''; const h=parseInt(t.split(':')[0],10); return h<12?'ص':'م'; }
        const out=[];
        const radios=document.querySelectorAll('input[type="radio"][name="ss"]:not(:disabled)');
        for(const r of radios){
          const value=r.value||''; // date*time
          const [date,time24]=value.split('*');
          const label = time24 ? `${date} - ${time24} ${p(time24)}` : `${date}`;
          out.push({label,value});
        }
        return out;
      });

      await browser.close();
      res.json({ times });
    }catch(e){
      try{ await browser.close(); }catch(_){}
      res.json({ times:[], error:e?.message||String(e) });
    }
  } catch (e) {
    res.json({ times: [], error: e?.message||String(e) });
  }
});

/** ===== Booking queue ===== */
const bookingQueue = [];
let processingBooking=false;

app.post('/api/book', async (req,res)=>{ bookingQueue.push({req,res}); processQueue(); });

async function processQueue(){
  if(processingBooking || !bookingQueue.length) return;
  processingBooking=true;

  const { req, res } = bookingQueue.shift();
  let account=null;
  try{
    account = await acquireAccount();
    const msg = await bookNow({ ...req.body, account });
    res.json({ msg });
  }catch(e){
    res.json({ msg:'❌ فشل الحجز! '+(e?.message||String(e)) });
  }finally{
    if(account) releaseAccount(account);
    processingBooking=false;
    processQueue();
  }
}

/** ===== Booking flow (CONFIRM) ===== */
async function bookNow({ name, phone, clinic, month, time, account }){
  const browser = await launchBrowserSafe();
  const page = await browser.newPage(); await prepPage(page);
  try{
    await loginToImdad(page, account);
    await gotoAppointments(page);

    const clinicValue = await page.evaluate((name) => {
      const opts = Array.from(document.querySelectorAll('#clinic_id option'));
      const f = opts.find(o => (o.textContent||'').trim() === name);
      return f ? f.value : null;
    }, clinic);
    if(!clinicValue) throw new Error('لم يتم العثور على العيادة!');
    await Promise.all([
      page.waitForNavigation({waitUntil:'domcontentloaded', timeout:120000}),
      page.select('#clinic_id', clinicValue)
    ]);

    // ✅ طبّق "1 month" قبل اختيار الشهر
    await applyOneMonthView(page);

    const months = await page.evaluate(()=>Array.from(document.querySelectorAll('#month1 option')).map(o=>({value:o.value,text:o.textContent})));
    const monthValue = months.find(m => m.text === month || m.value === month)?.value;
    if(!monthValue) throw new Error('لم يتم العثور على الشهر المطلوب!');
    await Promise.all([
      page.waitForNavigation({waitUntil:'domcontentloaded', timeout:120000}),
      page.select('#month1', monthValue)
    ]);

    // ✅ اكتب الاسم ثم اختر الاقتراح الذي يطابق رقم المريض (وليس أول عنصر)
    const phone05 = toLocal05(phone);
    await typeSlow(page, '#SearchBox120', normalizeArabic(name), 140);

    // انتظر الاقتراحات واقتنص المطابق للرقم
    let picked = false;
    const deadline = Date.now() + 12000;
    while (!picked && Date.now() < deadline) {
      const items = await readApptSuggestions(page);
      const enriched = items.map(it => ({ ...it, parsed: parseSuggestionText(it.text) }));
      const match = enriched.find(it => phonesEqual05(it.parsed.phone, phone05));
      if (match) {
        await page.evaluate((idx)=>{
          const lis = document.querySelectorAll('li[onclick^="fillSearch120"], .searchsugg120 li');
          if(lis && lis[idx]) lis[idx].click();
        }, match.idx);
        picked = true;
        break;
      }
      // حفّز القائمة
      await page.evaluate(()=>{
        const el = document.querySelector('#SearchBox120');
        if (el) {
          ['input','keyup','keydown','change'].forEach(ev=> el.dispatchEvent(new Event(ev, { bubbles: true })));
        }
      });
      await sleep(250);
    }
    // لو ما حصلنا رقم مطابق، نرجع للسلوك السابق: أول عنصر
    if (!picked) {
      const fallback = await pickFirstSuggestionOnAppointments(page, 3000);
      if (!fallback) throw new Error('تعذر اختيار المريض من قائمة الاقتراحات!');
    }

    await page.$eval('input[name="phone"]', (el,v)=>{ el.value=v; }, toLocal05(phone));
    await page.$eval('input[name="notes"]', (el,v)=>{ el.value=v; }, 'حجز أوتوماتيكي');
    await page.select('select[name="gender"]', '1');
    await page.select('select[name="nation_id"]', '1');

    const selected = await page.evaluate((wanted)=>{
      const radios=document.querySelectorAll('input[type="radio"][name="ss"]');
      for(const r of radios){ if(r.value===wanted && !r.disabled){ r.click(); return true; } }
      return false;
    }, time);
    if(!selected) throw new Error('لم يتم العثور على الموعد المطلوب!');

    const pressed = await page.evaluate(()=>{
      const btn=Array.from(document.querySelectorAll('input[type="submit"][name="submit"]'))
        .find(el=>el.value && el.value.trim()==='حجز : Reserve');
      if(!btn) return false;
      btn.disabled=false; btn.removeAttribute('disabled'); btn.click(); return true;
    });
    if(!pressed) throw new Error('زر الحجز غير متاح!');

    await page.waitForSelector('#popupContact', { visible:true, timeout:15000 }).catch(()=>null);
    await browser.close();
    return '✅ تم الحجز بنجاح بالحساب: '+account.user;
  }catch(e){
    await browser.close();
    return '❌ فشل الحجز: '+(e?.message||'حدث خطأ غير متوقع');
  }
}

/** ===== Verify OTP (optional) ===== */
app.post('/verify-otp', (req,res)=>{
  let { phone, otp } = req.body || {};
  if(verifyOtpInline(phone, otp)){ delete otpStore[normalizePhoneIntl(phone)]; return res.json({ success:true }); }
  return res.json({ success:false, message:'رمز التحقق غير صحيح!' });
});

/** ===== Health/Diag ===== */
app.get('/health', (_req,res)=> res.json({
  ok:true,
  time:new Date().toISOString(),
  chrome:CHROMIUM_PATH||'bundled',
  baseCacheDir: BASE_DL_DIR,
  debug:DEBUG_BROWSER
}));

/** ===== Start server ===== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', ()=> console.log(`Server running on http://0.0.0.0:${PORT} (debug=${DEBUG_BROWSER})`));
