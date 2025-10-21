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

/** ===== Puppeteer launch ===== */
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
    } catch (e2) { throw e2; }
  }
}
async function prepPage(page){
  await page.setViewport({ width: 1280, height: 900 });
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(120000);
  await page.setExtraHTTPHeaders({ 'Accept-Language':'ar-SA,ar;q=0.9,en;q=0.8' });
  await page.emulateTimezone('Asia/Riyadh').catch(()=>{});
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36');
  if (typeof page.waitForTimeout !== 'function') {
    page.waitForTimeout = (ms) => new Promise(res => setTimeout(res, ms));
  }
}

/** ===== Login / Nav ===== */
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
async function pickFirstSuggestionOnAppointments(page, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await page.evaluate(() => {
      const li = document.querySelector('li[onclick^="fillSearch120"], .searchsugg120 li');
      if (li) { li.click(); return true; }
      return false;
    });
    if (ok) return true;
    await page.evaluate(() => {
      const el = document.querySelector('#SearchBox120');
      if (el) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
      }
    });
    await sleep(300);
  }
  return false;
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
  if (!typedOk) {
    console.warn('[IMDAD] identity typing mismatch – giving up.');
    return { ok:false, reason:'id_type_mismatch' };
  }
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

  const idStatus = await readIdentityStatus(page, fileId);
  let pagePhone = '';
  try {
    pagePhone = await page.evaluate(()=>{
      function toAscii(s){const map={'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'};return String(s).replace(/[٠-٩]/g, d=>map[d]||d);}
      const tds = Array.from(document.querySelectorAll('td[height="29"]'));
      for(const td of tds){
        const digits = toAscii((td.textContent||'').trim()).replace(/\D/g,'');
        if(/^05\d{8}$/.test(digits)) return digits;
      }
      const inp = document.querySelector('#phone');
      if (inp && inp.value) {
        const d = toAscii(inp.value).replace(/\D/g,'');
        if(/^05\d{8}$/.test(d)) return d;
      }
      return '';
    });
  } catch {}

  const idDigitsPage = toAsciiDigits(idStatus?.ssnVal || '').replace(/\D/g,'');
  const identityMatches = digi && idDigitsPage && idDigitsPage.endsWith(digi);
  const phoneMatches = pagePhone ? phonesEqual05(pagePhone, expectedPhone05) : true;

  if (!identityMatches) return { ok:false, reason:'id_mismatch', fileId, foundId: idDigitsPage };
  if (expectedPhone05 && pagePhone && !phoneMatches) {
    return { ok:false, reason:'phone_mismatch', fileId, liPhone: pagePhone };
  }
  return { ok:true, fileId, liPhone: pagePhone, hasIdentity: !!idDigitsPage };
}

/** ===== Duplicate phone detect ===== */
async function isDuplicatePhoneWarning(page){
  try {
    const found = await page.evaluate(()=>{
      const txt = (document.body.innerText||'').replace(/\s+/g,' ');
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
    console.log('[BOOK] بدأ تنفيذ الحجز...', { clinic, month, time, identity, phone });


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
        await browser.close(); if(account) releaseAccount(account);
        if (searchRes.reason === 'phone_mismatch') {
          return res.json({ success:false, exists:true, reason:'phone_mismatch', message:'رقم الجوال غير متطابق مع الهوية' });
        }
        return res.json({ success:false, exists:false, message:'لا تملك ملفًا لدينا. انقر (افتح ملف جديد).' });
      }

      const fileId = searchRes.fileId;
      const liPhone = searchRes.liPhone;

      if (liPhone) {
        if (!phonesEqual05(liPhone, phone)) {
          await browser.close(); if(account) releaseAccount(account);
          return res.json({ success:false, exists:true, reason:'phone_mismatch', message:'رقم الجوال غير متطابق مع الهوية' });
        }
      } else {
        console.log('[IMDAD] patient has no phone on file; accepting identity match.');
      }

      const idStatus = await readIdentityStatus(page, fileId);

      await browser.close(); if(account) releaseAccount(account);

      return res.json({
        success:true,
        exists:true,
        fileId,
        hasIdentity: idStatus.hasIdentity,
        pickedText: searchRes.pickedText
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
      const ascii = toAscii(val).replace(/\س+/g,' ');
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

      const _isTripleName = (n)=> (n||'').trim().split(/\س+/).filter(Boolean).length === 3;
      const _isSaudi05 = (v)=> /^05\d{8}$/.test(toAsciiDigits(v||'').replace(/\D/g,''));
      const _normalize = (s='') => (s||'').replace(/\س+/g,' ').trim();

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
    const autoPeriod =
      /\*\*الفترة الثانية$/.test(clinicStr) ? 'evening' :
      (/\*\*الفترة الاولى$/.test(clinicStr) ? 'morning' : null);
    const effectivePeriod = period || autoPeriod;

    const DERM_EVENING_VALUE = 'عيادة الجلدية والتجميل (NO.200)**الفترة الثانية';
    const isDermEvening = clinicStr === DERM_EVENING_VALUE;

    const timeToMinutes = (t)=>{ if(!t) return NaN; const [H,M='0']=t.split(':'); return (+H)*60 + (+M) };
    const to12h = (t)=>{ if(!t) return ''; let [H,M='0']=t.split(':'); H=+H; M=String(+M).padStart(2,'0'); const am=H<12; let h=H%12; if(h===0) h=12; return `${h}:${M} ${am?'ص':'م'}`; };
    const inMorning = (t)=>{ const m=timeToMinutes(t); return m>=8*60 && m<=11*60+30; };
    const inEvening = (t)=>{ const m=timeToMinutes(t); const start = isDermEvening ? 15*60 : 16*60; return m>=start && m<=22*60; };

    const baseClinicName = clinicStr.split('**')[0].trim();
    const asciiClinic = toAsciiDigits(baseClinicName);
    const isWomenClinic = /النساء|الولادة/.test(baseClinicName);
    const isDermClinic   = /الجلدية/.test(baseClinicName);
    const isDentalWord = /الأسنان|الاسنان/i.test(baseClinicName);
    const has124Number = /(^|[^0-9])(1|2|4)($|[^0-9])/.test(asciiClinic);
    const dental124Names = [
      'عيادة الأسنان 1','عيادة الأسنان 2','عيادة الأسنان 4',
      'عيادة الاسنان 1','عيادة الاسنان 2','عيادة الاسنان 4'
    ].map(n => toAsciiDigits(n));
    const isDental124 =
      (isDentalWord && has124Number) ||
      dental124Names.some(n => asciiClinic.includes(n));

    const shouldBlockFriSat = (() => {
      if (isDermClinic && (effectivePeriod === 'evening' || isDermEvening)) return true;
      if (isWomenClinic) return true;
      if (isDental124) return true;
      return false;
    })();

    const browser = await launchBrowserSafe();
    const page = await browser.newPage(); await prepPage(page);
    try{
      await loginToImdad(page, { user:'1111111111', pass:'1111111111' });
      await gotoAppointments(page);

      const clinicValue = await page.evaluate((name) => {
        const opts = Array.from(document.querySelectorAll('#clinic_id option'));
        const f = opts.find(o => (o.textContent||'').trim() === name || (o.value||'') === name);
        return f ? f.value : null;
      }, clinic);
      if(!clinicValue) throw new Error('لم يتم العثور على العيادة!');

      await Promise.all([
        page.waitForNavigation({waitUntil:'domcontentloaded', timeout:120000}),
        page.select('#clinic_id', clinicValue)
      ]);

      await applyOneMonthView(page);
      

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

  try {
    sel.value = hit.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (_) {}

  try { if (hit.value) window.location.href = hit.value; } catch (_) {}

  return hit.value;
}, month);

if (!pickedMonth) throw new Error('month_not_found');

// انتظر تحميل صفحة الشهر
await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});


      const raw = await page.evaluate(()=>{
        const out=[];
        const radios=document.querySelectorAll('input[type="radio"][name="ss"]:not(:disabled)');
        for(const r of radios){
          const value=r.value||'';
          const [date,time24]=value.split('*');
          out.push({ value, date: (date||'').trim(), time24: (time24||'').trim() });
        }
        return out;
      });

      let filtered = raw;
      if (effectivePeriod === 'morning') filtered = raw.filter(x => x.time24 && inMorning(x.time24));
      if (effectivePeriod === 'evening') filtered = raw.filter(x => x.time24 && inEvening(x.time24));

      // Overrides لبعض العيادات المسائية
      (function applyClinicEveningOverrides() {
        const isEveningNow = (effectivePeriod === 'evening') || /\*\*الفترة الثانية$/.test(clinicStr);
        if (!isEveningNow) return;

        const baseClinic = baseClinicName;
        const ascii = asciiClinic;

        const isDentalWordHere = /الأسنان|الاسنان/i.test(baseClinic);
        const isDental1 = isDentalWordHere && /(^|[^0-9])1([^0-9]|$)/.test(ascii);
        const isDental2 = isDentalWordHere && /(^|[^0-9])2([^0-9]|$)/.test(ascii);
        const isDental4 = isDentalWordHere && /(^|[^0-9])4([^0-9]|$)/.test(ascii);
        const isDental5 = isDentalWordHere && /(^|[^0-9])5([^0-9]|$)/.test(ascii);
        const isDerm = /الجلدية|التجميل/.test(baseClinic);
        const isSkinClean = /(تنظيف.?البشرة|هايدرافيشل|التشقير)/i.test(baseClinic);

        const between = (t, h1, m1, h2, m2) => {
          const m = timeToMinutes(t);
          const s = h1*60 + m1, e = h2*60 + m2;
          return m >= s && m <= e;
        };

        if (isDental1 || isDental2) {
          filtered = raw.filter(x => x.time24 && between(x.time24, 16, 0, 20, 30));
          return;
        }
        if (isDental4) {
          filtered = raw.filter(x => x.time24 && between(x.time24, 14, 0, 21, 30));
          return;
        }
        if (isDental5) {
          filtered = raw.filter(x => x.time24 && between(x.time24, 12, 0, 19, 30));
          return;
        }
        if (isDerm) {
          filtered = raw.filter(x => x.time24 && between(x.time24, 15, 0, 21, 30));
          return;
        }
        if (isSkinClean) {
          filtered = raw.filter(x => x.time24 && between(x.time24, 15, 30, 21, 30));
          return;
        }
      })();

      if (shouldBlockFriSat) {
        const isFriOrSat = (dateStr)=> {
          const [Y,M,D] = (dateStr||'').split('-').map(n=>+n);
          if(!Y||!M||!D) return false;
          const wd = new Date(Date.UTC(Y, M-1, D)).getUTCDay();
          return wd === 5 || wd === 6;
        };
        filtered = filtered.filter(x => !isFriOrSat(x.date));
      }

      const times = filtered.map(x => ({
        value: x.value,
        label: `${x.date} - ${to12h(x.time24)}`
      }));

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

/** ===== Booking queue (single) ===== */
const bookingQueue = [];
let processingBooking=false;

app.post('/api/book', async (req,res)=>{ bookingQueue.push({req,res}); processQueue(); });

async function processQueue(){
  if(processingBooking || !bookingQueue.length) return;
  processingBooking=true;

  const { req, res } = bookingQueue.shift();
  try{
    const msg = await bookNow({ ...req.body }); // bookNow يدير الحساب والمتصفح
    res.json({ msg });
  }catch(e){
    res.json({ msg:'❌ فشل الحجز! '+(e?.message||String(e)) });
  }finally{
    processingBooking=false;
    processQueue();
  }
}

/** ===== Booking flow (single) ===== */
async function bookNow({ identity, name, phone, clinic, month, time, note }){
  const browser = await launchBrowserSafe();
  const page = await browser.newPage(); await prepPage(page);

  let account = null;
  try{
    account = await acquireAccount();
    await loginToImdad(page, account);
    await gotoAppointments(page);

    // اختر العيادة
    const clinicValue = await page.evaluate((name) => {
      const opts = Array.from(document.querySelectorAll('#clinic_id option'));
      const f = opts.find(o => (o.textContent||'').trim() === name || (o.value||'') === name);
      return f ? f.value : null;
    }, clinic);
    if(!clinicValue) throw new Error('لم يتم العثور على العيادة!');

    await Promise.all([
      page.waitForNavigation({waitUntil:'domcontentloaded', timeout:120000}),
      page.select('#clinic_id', clinicValue)
    ]);

    // 1 month ثم الشهر
    // 🔹 لا حاجة لاختيار الشهر لأن التاريخ مضمّن في firstTimeValue
const first = parseTimeValue(firstTimeValue || time);


    // اكتب مفتاح البحث (الهوية أولوية)
    console.log('[BOOK] يبحث عن المريض برقم الهوية أو الجوال...');
    const searchKey = (identity && String(identity).trim()) || (name && normalizeArabic(name)) || '';
    if (!searchKey) throw new Error('لا يوجد مفتاح بحث (هوية/اسم)!');
    await typeSlow(page, '#SearchBox120', searchKey, 120);

    // اختر المريض من الاقتراحات (الأولوية للجوال)
    const phone05 = toLocal05(phone || '');
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
      await page.evaluate(()=> {
        const el = document.querySelector('#SearchBox120');
        if (el) ['input','keyup','keydown','change'].forEach(ev=> el.dispatchEvent(new Event(ev,{bubbles:true})));
      });
      await sleep(250);
    }
    if (!picked) {
      const fallback = await pickFirstSuggestionOnAppointments(page, 3000);
      if (!fallback) throw new Error('تعذر اختيار المريض من قائمة الاقتراحات!');
    }

    // ثبّت الهاتف + ملاحظة المستخدم فقط
    await page.$eval('input[name="phone"]', (el,v)=>{ el.value=v; }, toLocal05(phone));
    if (typeof note === 'string' && note.trim()) {
      await page.$eval('input[name="notes"]', (el,v)=>{ el.value=v; }, note.trim());
    } else {
      await page.$eval('input[name="notes"]', (el)=>{ el.value=''; });
    }

    await page.select('select[name="gender"]', '1');
    await page.select('select[name="nation_id"]', '1');

    // اختر الوقت
    const selected = await page.evaluate((wanted)=>{
      const radios=document.querySelectorAll('input[type="radio"][name="ss"]');
      for(const r of radios){
        if(r.value===wanted && !r.disabled){ r.click(); return true; }
      }
      return false;
    }, time);
    if(!selected) throw new Error('لم يتم العثور على الموعد المطلوب!');

    // احجز
    const pressed = await page.evaluate(()=>{
      const btn=Array.from(document.querySelectorAll('input[type="submit"][name="submit"]'))
        .find(el=>el.value && el.value.trim()==='حجز : Reserve');
      if(!btn) return false;
      console.log('[BOOK] يضغط زر الحجز الآن...');
      btn.disabled=false; btn.removeAttribute('disabled'); btn.click(); return true;
    });
    if(!pressed) throw new Error('زر الحجز غير متاح!');

    await page.waitForSelector('#popupContact', { visible:true, timeout:15000 }).catch(()=>null);
    console.log('[BOOK] ✅ ظهر إشعار نجاح الحجز!');


    await browser.close(); if(account) releaseAccount(account);
    return '✅ تم الحجز بنجاح بالحساب: '+account.user;
  }catch(e){
    try{ await browser.close(); }catch(_){}
    if(account) releaseAccount(account);
    return '❌ فشل الحجز: '+(e?.message||'حدث خطأ غير متوقع');
    console.error('[BOOK ❌ خطأ أثناء الحجز]', e?.message || e);

  }
}

/** ===== build chain utils ===== */
function parseTimeValue(v){
  const [date, t] = String(v||'').split('*');
  if (!date || !t) return null;
  const [H, M='0'] = t.split(':');
  return { date, H: +H, M: +M, mm: (+H)*60 + (+M) };
}
function buildChainTimes(firstValue, slotsCount){
  const p = parseTimeValue(firstValue);
  if (!p) return [];
  const out = [];
  for(let i=0;i<slotsCount;i++){
    const mm = p.mm + 15*i;
    const H = Math.floor(mm/60), M = mm%60;
    const t = String(H).padStart(2,'0') + ':' + String(M).padStart(2,'0');
    out.push(`${p.date}*${t}`);
  }
  return out;
}

/** ===== bookMultiChain ===== */
async function bookMultiChain({ identity, phone, clinic, month, firstTimeValue, slotsCount, note, account }){
  const browser = await launchBrowserSafe();
  const page = await browser.newPage(); await prepPage(page);
  let acc = account;
  try{
    if (!acc) acc = await acquireAccount();
    await loginToImdad(page, acc);
    await gotoAppointments(page);

    // اختر العيادة
    console.log('[BOOK] يختار العيادة...', clinic);
    const clinicValue = await page.evaluate((name) => {
      const opts = Array.from(document.querySelectorAll('#clinic_id option'));
      const f = opts.find(o => (o.textContent||'').trim() === name || (o.value||'') === name);
      return f ? f.value : null;
    }, clinic);
    if(!clinicValue) throw new Error('لم يتم العثور على العيادة!');
    await Promise.all([
      page.waitForNavigation({waitUntil:'domcontentloaded', timeout:120000}),
      page.select('#clinic_id', clinicValue)
    ]);

    // 1 month ثم الشهر
    await applyOneMonthView(page);
    console.log('[BOOK] يحاول اختيار الشهر...', month);
    const months = await page.evaluate(()=>Array.from(document.querySelectorAll('#month1 option')).map(o=>({value:o.value,text:(o.textContent||'').trim()})));
    const monthValue = months.find(m => m.text === String(month) || m.value === String(month))?.value;
    if(!monthValue) throw new Error('لم يتم العثور على الشهر!');
    await Promise.all([
      page.waitForNavigation({waitUntil:'domcontentloaded', timeout:120000}),
      page.select('#month1', monthValue)
    ]);
    console.log('[BOOK] تم تحديد الشهر بنجاح:', monthValue);

    // اكتب الهوية
    await typeSlow(page, '#SearchBox120', String(identity||'').trim(), 120);

    // اختر المريض (أولوية للجوال)
    const phone05 = toLocal05(phone||'');
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
        picked = true; break;
      }
      await page.evaluate(()=>{ const el=document.querySelector('#SearchBox120'); if(el){['input','keyup','keydown','change'].forEach(ev=>el.dispatchEvent(new Event(ev,{bubbles:true})));} });
      await sleep(200);
    }
    if (!picked) {
      const fallback = await pickFirstSuggestionOnAppointments(page, 3000);
      if (!fallback) throw new Error('تعذّر اختيار المريض من الاقتراحات!');
    }

    // ثبّت الهاتف والملاحظة
    await page.$eval('input[name="phone"]', (el,v)=>{ el.value=v; }, toLocal05(phone));
    if (typeof note === 'string' && note.trim()) {
      await page.$eval('input[name="notes"]', (el,v)=>{ el.value=v; }, note.trim());
    } else {
      await page.$eval('input[name="notes"]', (el)=>{ el.value=''; });
    }
    await page.select('select[name="gender"]', '1');
    await page.select('select[name="nation_id"]', '1');

    const chain = buildChainTimes(firstTimeValue, Math.max(1, +slotsCount||1));
    const successes = [];

    for (let i=0;i<chain.length;i++){
      const wanted = chain[i];

      const selected = await page.evaluate((val)=>{
        const radios = document.querySelectorAll('input[type="radio"][name="ss"]');
        for(const r of radios){
          if(r.value===val && !r.disabled){ r.click(); return true; }
        }
        return false;
      }, wanted);
      if(!selected) break;

      const pressed = await page.evaluate(()=>{
        const btn=Array.from(document.querySelectorAll('input[type="submit"][name="submit"]'))
          .find(el=>el.value && el.value.trim()==='حجز : Reserve');
        if(!btn) return false;
        btn.disabled=false; btn.removeAttribute('disabled'); btn.click(); return true;
      });
      if(!pressed) break;

      await page.waitForSelector('#popupContact', { visible:true, timeout:15000 }).catch(()=>null);
      successes.push(wanted);

      // ارجع للمواعيد لنفس العيادة/الشهر للجولة التالية
      await gotoAppointments(page);
      await Promise.all([
        page.waitForNavigation({waitUntil:'domcontentloaded', timeout:120000}),
        page.select('#clinic_id', clinicValue)
      ]);
      await applyOneMonthView(page);
      await Promise.all([
        page.waitForNavigation({waitUntil:'domcontentloaded', timeout:120000}),
        page.select('#month1', monthValue)
      ]);
      // إعادة تحديد المريض سريعًا بالجوال
      await typeSlow(page, '#SearchBox120', phone05, 80);
      await pickFirstSuggestionOnAppointments(page, 2500);
      await page.$eval('input[name="phone"]', (el,v)=>{ el.value=v; }, toLocal05(phone));
      if (typeof note === 'string' && note.trim()) {
        await page.$eval('input[name="notes"]', (el,v)=>{ el.value=v; }, note.trim());
      } else {
        await page.$eval('input[name="notes"]', (el)=>{ el.value=''; });
      }
    }

    await browser.close(); if(!account && acc) releaseAccount(acc);

    if (successes.length === chain.length) {
      return { ok:true, message:`تم حجز ${successes.length} خانة متتالية بنجاح` };
    } else if (successes.length > 0) {
      return { ok:true, partial:true, message:`تم حجز ${successes.length} خانة، وبعض الخانات غير متاحة` };
    } else {
      return { ok:false, message:'تعذر حجز أي خانة' };
    }
  } catch(e){
    try{ await browser.close(); }catch(_){}
    if(!account && acc) releaseAccount(acc);
    return { ok:false, message:'فشل الحجز المتسلسل: ' + (e?.message||String(e)) };
  }
}


// ===== API: /api/book-multi =====
app.post('/api/book-multi', async (req, res) => {
  let account = null;
  try {
    const {
      identity, phone, clinic, month,      // month اختياري ومهمل
      slotsCount, note
    } = req.body || {};

    // 👈 اجمع الوقت من أي اسم محتمَل ترسله الواجهة:
    const first = (req.body?.firstTimeValue || req.body?.time || req.body?.value || '').trim();

    if (!identity || !phone || !clinic || !first) {
      return res.json({ success:false, message:'حقول ناقصة (identity/phone/clinic/firstTimeValue)' });
    }

    account = await acquireAccount();

    const result = await bookMultiChain({
      identity,
      phone,
      clinic,
      month,                       // لن نستعمله داخل الدالة
      firstTimeValue: first,       // 👈 مرِّر المتغيّر المعرَّف محلياً
      slotsCount: Math.max(1, Number(slotsCount || 1)),
      note,
      account
    });

    return res.json({ success: !!result.ok, message: result.message });
  } catch (e) {
    return res.json({ success:false, message:'فشل الحجز المتعدد: ' + (e?.message || String(e)) });
  } finally {
    if (account) releaseAccount(account);
  }
});


/** ===== Verify OTP (optional) ===== */
app.post('/verify-otp', (req,res)=>{
  let { phone, otp } = req.body || {};
  if(verifyOtpInline(phone, otp)){ delete otpStore[normalizePhoneIntl(phone)]; return res.json({ success:true }); }
  return res.json({ success:false, message:'رمز التحقق غير صحيح!' });
});

/** ===== NEW: Create New Patient File ===== */
app.post('/api/new-file', async (req, res) => {
  const MASTER_TIMEOUT_MS = 90000;
  const masterTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout_master')), MASTER_TIMEOUT_MS));

  const handler = (async () => {
    try {
      const {
        fullName,
        nationalId,
        phone,
        nationality,
        gender,
        birthYear,
        birthMonth,
        birthDay,
        otp
      } = req.body || {};

      const nameNorm = normalizeArabic(fullName || '');
      const nameParts = nameNorm.split(' ').filter(Boolean);
      if (!nameParts.length || nameParts.length < 3) {
        return res.json({ success:false, message:'اكتب الاسم ثلاثيًّا على الأقل', reason:'invalid_input' });
      }
      if (!isSaudi05(phone)) {
        return res.json({ success:false, message:'رقم الجوال بصيغة 05xxxxxxxx', reason:'invalid_input' });
      }
      if (!nationalId || /^0+$/.test(String(nationalId).replace(/\D/g,''))) {
        return res.json({ success:false, message:'رقم الهوية غير صالح', reason:'invalid_input' });
      }
      if (!birthYear || !birthMonth || !birthDay) {
        return res.json({ success:false, message:'حدد تاريخ الميلاد (اليوم/الشهر/السنة)', reason:'invalid_input' });
      }
      if (!verifyOtpInline(phone, otp)) {
        return res.json({ success:false, message:'رمز التحقق غير صحيح', reason:'otp' });
      }
      const browser = await launchBrowserSafe();
      const page = await browser.newPage(); await prepPage(page);
      page.on('dialog', async d => { try { await d.accept(); } catch(_) {} });

      let account = null;
      try {
        account = await acquireAccountWithTimeout(20000);
        await loginToImdad(page, account);

        const phone05 = toLocal05(phone);

        // فحص مسبق: هل الجوال موجود؟
        if (await existsPatientByPhone(page, phone05)) {
          await browser.close(); if (account) releaseAccount(account);
          return res.json({ success:false, message:'رقم الجوال موجود مسبقًا', reason:'duplicate_phone' });
        }

        // افتح صفحة فتح ملف جديد
        const okPage = await openNewFilePage(page);
        if (!okPage) {
          await browser.close(); if (account) releaseAccount(account);
          return res.json({ success:false, message:'تعذّر فتح صفحة فتح ملف جديد', reason:'navigation' });
        }

        await page.waitForSelector('#fname', { timeout: 30000 });
        await page.waitForSelector('#phone', { timeout: 30000 });

        // املأ الحقول
        await page.$eval('#fname', (el,v)=>{ el.value=v; }, nameNorm);
        await page.$eval('#ssn', (el,v)=>{ el.value=v; }, String(nationalId));
        await page.select('#day12',   String(birthDay));
        await page.select('#month12', String(birthMonth));
        await page.select('#year12',  String(birthYear));
        await page.select('#gender', String(gender || '1'));

        if (nationality) {
          await page.evaluate((val)=>{
            const sel = document.querySelector('#n');
            if(!sel) return;
            if ([...sel.options].some(o=>o.value===String(val))) {
              sel.value = String(val);
              sel.dispatchEvent(new Event('change', {bubbles:true}));
            }
          }, String(nationality));
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
          await browser.close(); if (account) releaseAccount(account);
          return res.json({ success:false, message:'رقم الجوال موجود لمريض آخر', reason:'duplicate_phone' });
        }

        await page.waitForSelector('#submit', { timeout: 20000 });
        await page.evaluate(() => {
          const btn = document.querySelector('#submit');
          if (btn) { btn.disabled=false; btn.removeAttribute('disabled'); btn.click(); }
        });

        await page.waitForNavigation({ waitUntil:'domcontentloaded', timeout: 30000 }).catch(()=>{});
        await sleep(1200);

        if (await isDuplicatePhoneWarning(page)) {
          await browser.close(); if (account) releaseAccount(account);
          return res.json({ success:false, message:'رقم الجوال موجود لمريض آخر', reason:'duplicate_phone' });
        }

        let fileId = '';
        try {
          const hrefId = await page.evaluate(()=>{
            const a1 = document.querySelector('a[href^="stq_search2.php?id="]');
            if (a1) return a1.getAttribute('href') || '';
            const a2 = document.querySelector('a[href*="stq_edit.php?id="]');
            if (a2) return a2.getAttribute('href') || '';
            return location.href || '';
          });
          fileId = (hrefId.match(/id=(\d+)/) || [])[1] || extractFileId(hrefId) || '';
        } catch(_) {}

        await browser.close(); if (account) releaseAccount(account);

        delete otpStore[normalizePhoneIntl(phone)];

        if (!fileId) {
          return res.json({ success:false, message:'تم الحفظ لكن تعذّر استخراج رقم الملف', reason:'unknown' });
        }

        return res.json({
          success:true,
          fileId,
          fullName: nameNorm,
          phoneLocal: phone05,
          message:'تم فتح الملف بنجاح'
        });

      } catch (e) {
        console.error('/api/new-file error', e?.message || e);
        try { await browser.close(); } catch(_){}
        if (account) releaseAccount(account);
        if (String(e?.message||e)==='imdad_busy') {
          return res.json({ success:false, message:'النظام مشغول حاليًا، حاول بعد قليل', reason:'imdad_busy' });
        }
        return res.json({ success:false, message:'فشل إنشاء الملف: ' + (e?.message || e), reason:'unknown' });
      }
    } catch (e) {
      return res.json({ success:false, message:'خطأ غير متوقع', reason:'unknown' });
    }
  })();

  Promise.race([handler, masterTimeout]).catch(async (_e)=>{
    try { return res.json({ success:false, reason:'timeout', message:'المهلة انتهت' }); }
    catch(_) { /* ignore */ }
  });
});

/** =========================================================
 *                 Persistent Metrics (stats.json)
 * ========================================================= */
const METRICS_PATH = process.env.METRICS_PATH || path.join(__dirname, 'stats.json');
const STAFF_KEY = process.env.STAFF_KEY || '';

function ensureDir(p) {
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.error('[metrics] ensureDir error:', e?.message || e);
  }
}
function safeReadJSON(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const txt = fs.readFileSync(p, 'utf8');
    return JSON.parse(txt);
  } catch (e) {
    console.error('[metrics] read error:', e?.message || e);
    return fallback;
  }
}
function safeWriteJSON(p, obj) {
  try {
    ensureDir(p);
    const tmp = p + '.tmp';
    const bak = p + '.bak';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    if (fs.existsSync(p)) fs.copyFileSync(p, bak);
    fs.renameSync(tmp, p);
  } catch (e) {
    console.error('[metrics] write error:', e?.message || e);
  }
}
function loadMetrics() {
  const init = { ok: true, total: 0, byClinic: {}, byDate: {}, byDateClinic: {} };
  const main = safeReadJSON(METRICS_PATH, null);
  if (main) return {
    ok: true,
    total: Number(main.total||0),
    byClinic: main.byClinic||{},
    byDate: main.byDate||{},
    byDateClinic: main.byDateClinic||{}
  };
  const backup = safeReadJSON(METRICS_PATH + '.bak', null);
  if (backup) return {
    ok: true,
    total: Number(backup.total||0),
    byClinic: backup.byClinic||{},
    byDate: backup.byDate||{},
    byDateClinic: backup.byDateClinic||{}
  };
  safeWriteJSON(METRICS_PATH, init);
  return init;
}
let METRICS = loadMetrics();
let _writing = false, _pendingWrite = false;
function saveMetrics() {
  if (_writing) { _pendingWrite = true; return; }
  _writing = true;
  try { safeWriteJSON(METRICS_PATH, METRICS); }
  finally {
    _writing = false;
    if (_pendingWrite) { _pendingWrite = false; saveMetrics(); }
  }
}
function todayKeyRiyadh() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date()); // YYYY-MM-DD
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

/** Track success (called from success.html) */
app.post('/api/track-success', (req, res) => {
  try {
    const { clinic } = req.body || {};
    incMetrics({ clinic });
    return res.json({ ok: true });
  } catch (e) {
    console.error('/api/track-success', e?.message || e);
    return res.status(500).json({ ok: false, error: 'failed' });
  }
});

/** Staff dashboard summary (protected) */
app.get('/api/stats/summary', (req, res) => {
  const key = req.headers['x-staff-key'] || req.query.key || '';
  if (!STAFF_KEY || key !== STAFF_KEY) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  METRICS = loadMetrics(); // حمّل آخر نسخة قبل الإرجاع
  return res.json(METRICS);
});

/** Reset metrics (protected) */
app.post('/api/stats/reset', (req, res) => {
  const key = req.headers['x-staff-key'] || req.query.key || '';
  if (!STAFF_KEY || key !== STAFF_KEY) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  METRICS = { ok: true, total: 0, byClinic: {}, byDate: {}, byDateClinic: {} };
  saveMetrics();
  res.json({ ok: true });
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
