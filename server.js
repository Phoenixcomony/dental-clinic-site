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

// 1) SEO 301: من الاسم الإنجليزي → أول مسار عربي (الكانوني)
for (const [file, slugs] of Object.entries(canonical)) {
  const target = `/${slugs[0]}`;
  app.get(`/${file}`, (req, res) => res.redirect(301, target));
}

// 2) خدمة الملفات عند زيارة المسارات العربية (تفك ترميز %D8…)
app.get('*', (req, res, next) => {
  let p = req.path;
  try { p = decodeURIComponent(p); } catch (_) {}
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);

  for (const [file, slugs] of Object.entries(canonical)) {
    for (const slug of slugs) {
      if (p === `/${slug}`) {
        return res.sendFile(path.join(__dirname, file));
      }
    }
  }
  next();
});

// 3) (اختياري) خَلّ الجذر يظهر المسار الجميل للرئيسية
app.get('/', (req, res) => res.redirect(302, `/${canonical['index.html'][0]}`));

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

/** ===== Puppeteer launch (headless-hardened) ===== */
function launchOpts(){
  const exe = CHROMIUM_PATH || undefined;
  return {
    executablePath: exe,
    headless: 'new',
    ignoreHTTPSErrors: true,
    devtools: !!DEBUG_BROWSER,
    slowMo: 0,
    protocolTimeout: PUPPETEER_PROTOCOL_TIMEOUT_MS,
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-gpu','--disable-software-rasterizer','--no-zygote','--single-process',
      '--disable-extensions','--disable-background-networking','--disable-background-timer-throttling',
      '--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows',
      '--use-gl=swiftshader','--use-angle=swiftshader','--window-size=1280,900',
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

/** ===== Login / Navigation ===== */
async function loginToImdad(page, {user, pass}){
  await page.goto('https://phoenix.imdad.cloud/medica13/login.php?a=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name="username"]', { timeout: 30000 });
  await page.$eval('input[name="username"]', (el,v)=>{el.value=v;}, user);
  await page.$eval('input[name="password"]', (el,v)=>{el.value=v;}, pass);
  await Promise.race([page.waitForNavigation({waitUntil:'domcontentloaded', timeout: 30000}), page.click('#submit')]).catch(()=>{});
  const ok = await page.waitForSelector('#navbar-search-input, a[href*="appoint_display.php"]', { timeout: 15000 })
    .then(()=>true).catch(()=>false);
  if (!ok) throw new Error('login_failed');
}
async function gotoAppointments(page){
  await page.goto('https://phoenix.imdad.cloud/medica13/appoint_display.php', { waitUntil:'domcontentloaded' });
}

/** ===== Utilities ===== */
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
async function readApptSuggestions(page){
  return await page.evaluate(()=>{
    const lis = Array.from(document.querySelectorAll('li[onclick^="fillSearch120"], .searchsugg120 li'));
    return lis.map((li,idx)=>({ idx, text:(li.innerText||'').trim() }));
  });
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

// وقت
const timeToMinutes = (t)=>{ if(!t) return NaN; const [H,M='0']=t.split(':'); return (+H)*60 + (+M); };
const minutesToTime = (m)=>{ const H = Math.floor(m/60), M = m%60; return String(H).padStart(2,'0')+':'+String(M).padStart(2,'0'); };
const addMinutes = (hhmm, mins)=> minutesToTime(timeToMinutes(hhmm)+mins);

/** ===== Identity helpers (read/verify) ===== */
async function readIdentityStatus(page, fileId) {
  await page.goto(`https://phoenix.imdad.cloud/medica13/stq_edit.php?id=${fileId}`, { waitUntil:'domcontentloaded' }).catch(()=>{});
  try {
    await page.waitForSelector('#ssn', { timeout: 7000 });
    const ssnVal = await page.$eval('#ssn', el => (el.value || '').trim());
    const digits = toAsciiDigits(ssnVal).replace(/\D/g,'');
    const hasIdentity = !!(digits && !/^0+$/.test(digits) && digits.length >= 8 && !/^05\d{8}$/.test(digits));
    return { hasIdentity, ssnVal };
  } catch (_) {}
  return { hasIdentity:false, ssnVal:'' };
}

/** ===== WhatsApp OTP (send + 60s throttle) ===== */
const otpStore = {};        // { '9665XXXXXXXX': { code, ts } }
const otpThrottle = {};     // { '9665XXXXXXXX': lastSentTs }

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

/** ===== Login (by identity + phone check) ===== */
app.post('/api/login', async (req, res) => {
  try {
    const { identity, phone, otp } = req.body || {};
    const idDigits = toAsciiDigits(identity||'').replace(/\D/g,'');
    if(idDigits.length < 8) return res.status(200).json({ success:false, message:'اكتب رقم الهوية/الإقامة بشكل صحيح' });
    if(!isSaudi05(phone))  return res.status(200).json({ success:false, message:'رقم الجوال بصيغة 05xxxxxxxx' });
    if(!verifyOtpInline(phone, otp)) return res.status(200).json({ success:false, message:'رمز التحقق غير صحيح', reason:'otp' });

    const browser = await launchBrowserSafe();
    const page = await browser.newPage(); await prepPage(page);
    let account=null;
    try{
      account = await acquireAccount();
      await loginToImdad(page, account);

      // ابحث مباشرة بالهوية داخل صفحة التحرير للتحقق
      // (نهج مبسط: افتح بطاقة من الاقتراحات ثم اقرأ)
      await gotoAppointments(page);
      await typeSlow(page, '#SearchBox120', idDigits, 120);

      // اختر أول اقتراح
      const okPick = await pickFirstSuggestionOnAppointments(page, 6000);
      if (!okPick) {
        await browser.close(); releaseAccount(account);
        return res.json({ success:false, exists:false, message:'لا تملك ملفًا لدينا. انقر (افتح ملف جديد).' });
      }

      const patientHref = await page.evaluate(()=>{
        const a1 = document.querySelector('a[href^="stq_search2.php?id="]');
        if (a1) return a1.getAttribute('href');
        const icon = document.querySelector('a i.far.fa-address-card');
        if (icon && icon.closest('a')) return icon.closest('a').getAttribute('href');
        return '';
      });
      if(!patientHref){
        await browser.close(); releaseAccount(account);
        return res.json({ success:false, exists:false, message:'لا تملك ملفًا لدينا. انقر (افتح ملف جديد).' });
      }

      const fileId = ((patientHref.match(/id=(\d+)/) || [])[1] || '') || extractFileId(patientHref);
      await page.goto(`https://phoenix.imdad.cloud/medica13/${patientHref}`, { waitUntil: 'domcontentloaded' });

      // تحقق الجوال (إن وُجد في الصفحة)
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

      if (pagePhone && !phonesEqual05(pagePhone, phone)) {
        await browser.close(); releaseAccount(account);
        return res.json({ success:false, exists:true, reason:'phone_mismatch', message:'رقم الجوال غير متطابق مع الهوية' });
      }

      const idStatus = await readIdentityStatus(page, fileId);

      await browser.close(); releaseAccount(account);

      return res.json({
        success:true,
        exists:true,
        fileId,
        hasIdentity: idStatus.hasIdentity
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

/** ===== API: /api/update-identity ===== */
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

/** ===== New-File creation (kept as-is) ===== */
app.post('/api/new-file', async (req, res) => {
  const MASTER_TIMEOUT_MS = 90000;
  const masterTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout_master')), MASTER_TIMEOUT_MS));

  const handler = (async () => {
    try {
      const {
        fullName, nationalId, phone, nationality, gender,
        birthYear, birthMonth, birthDay, otp
      } = req.body || {};

      const nameNorm = normalizeArabic(fullName || '');
      if (nameNorm.split(' ').filter(Boolean).length < 3) {
        return res.json({ success:false, message:'اكتب الاسم ثلاثيًّا على الأقل', reason:'invalid_input' });
      }
      if (!isSaudi05(phone)) {
        return res.json({ success:false, message:'رقم الجوال بصيغة 05xxxxxxxx', reason:'invalid_input' });
      }
      if (!nationalId) {
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
        // (تبسيط: عبر شريط البحث/المواعيد)
        await gotoAppointments(page);
        await typeSlow(page, '#SearchBox120', phone05, 120);
        const sugg = await readApptSuggestions(page);
        if (sugg.some(it => phonesEqual05(parseSuggestionText(it.text).phone, phone05))) {
          await browser.close(); if (account) releaseAccount(account);
          return res.json({ success:false, message:'رقم الجوال موجود مسبقًا', reason:'duplicate_phone' });
        }

        // افتح صفحة فتح ملف جديد
        await page.goto('https://phoenix.imdad.cloud/medica13/stq_add.php', { waitUntil:'domcontentloaded' });

        await page.waitForSelector('#fname', { timeout: 30000 });
        await page.waitForSelector('#phone', { timeout: 30000 });

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

        // رقم الجوال
        await page.$eval('#phone', (el)=>{ el.value=''; });
        for (const ch of toLocal05(phone)) await page.type('#phone', ch, { delay: 140 });
        await sleep(700);

        await page.waitForSelector('#submit', { timeout: 20000 });
        await page.evaluate(() => {
          const btn = document.querySelector('#submit');
          if (btn) { btn.disabled=false; btn.removeAttribute('disabled'); btn.click(); }
        });

        await page.waitForNavigation({ waitUntil:'domcontentloaded', timeout: 30000 }).catch(()=>{});
        await sleep(900);

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
          phoneLocal: toLocal05(phone),
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
    catch(_) {}
  });
});

/** ===== Helper: تطبيق "1 month" ===== */
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

/** ===== API: /api/times  (يدعم السلاسل المتتالية needChainMin) ===== */
app.post('/api/times', async (req, res) => {
  try {
    const { clinic, month, period, needChainMin } = req.body || {};
    if (!clinic || !month) return res.status(400).json({ times: [], error: 'العيادة أو الشهر مفقود' });

    const autoPeriod =
      /\*\*الفترة الثانية$/.test(String(clinic)) ? 'evening' :
      (/\*\*الفترة الاولى$/.test(String(clinic)) ? 'morning' : null);
    const effectivePeriod = period || autoPeriod;

    // طول السلسلة المطلوبة (15 دقيقة كوحدة)
    const chainLen = Math.max(1, Math.ceil((Number(needChainMin)||30) / 15));

    const DERM_EVENING_VALUE = 'عيادة الجلدية والتجميل (NO.200)**الفترة الثانية';

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

      const months = await page.evaluate(()=>Array.from(document.querySelectorAll('#month1 option')).map(o=>({value:o.value,text:(o.textContent||'').trim()})));
      const monthValue = months.find(m => m.text === month || m.value === month)?.value;
      if(!monthValue) throw new Error('لم يتم العثور على الشهر المطلوب!');

      await Promise.all([
        page.waitForNavigation({waitUntil:'domcontentloaded', timeout:120000}),
        page.select('#month1', monthValue)
      ]);

      const raw = await page.evaluate(()=>{
        const out=[];
        const radios=document.querySelectorAll('input[type="radio"][name="ss"]:not(:disabled)');
        for(const r of radios){
          const value=r.value||''; // date*time
          const [date,time24]=value.split('*');
          out.push({ value, date: (date||'').trim(), time24: (time24||'').trim() });
        }
        return out;
      });

      // تصفية حسب الفترة/النوافذ الخاصة
      const baseClinicName = String(clinic).split('**')[0].trim();
      const asciiClinic = toAsciiDigits(baseClinicName);
      const isWomenClinic = /النساء|الولادة/.test(baseClinicName);
      const isDermClinic   = /الجلدية/.test(baseClinicName);
      const isDentalWord = /الأسنان|الاسنان/i.test(baseClinicName);
      const has124Number = /(^|[^0-9])(1|2|4)([^0-9]|$)/.test(asciiClinic);
      const dental124Names = [
        'عيادة الأسنان 1','عيادة الأسنان 2','عيادة الأسنان 4',
        'عيادة الاسنان 1','عيادة الاسنان 2','عيادة الاسنان 4'
      ].map(n => toAsciiDigits(n));
      const isDental124 =
        (isDentalWord && has124Number) ||
        dental124Names.some(n => asciiClinic.includes(n));

      const shouldBlockFriSat = (() => {
        if (isDermClinic && (effectivePeriod === 'evening' || String(clinic) === DERM_EVENING_VALUE)) return true;
        if (isWomenClinic) return true;
        if (isDental124) return true;
        return false;
      })();

      const inMorning = (t)=>{ const m=timeToMinutes(t); return m>=8*60 && m<=11*60+30; };
      const inEvening = (t)=>{ const m=timeToMinutes(t); const start = (String(clinic)===DERM_EVENING_VALUE)? 15*60 : 16*60; return m>=start && m<=22*60; };

      let filtered = raw.slice();
      if (effectivePeriod === 'morning') filtered = filtered.filter(x => x.time24 && inMorning(x.time24));
      if (effectivePeriod === 'evening') filtered = filtered.filter(x => x.time24 && inEvening(x.time24));

      // Overrides مسائية لبعض العيادات
      (function applyClinicEveningOverrides() {
        const isEveningNow = (effectivePeriod === 'evening') || /\*\*الفترة الثانية$/.test(String(clinic));
        if (!isEveningNow) return;
        const isDental1 = isDentalWord && /(^|[^0-9])1([^0-9]|$)/.test(asciiClinic);
        const isDental2 = isDentalWord && /(^|[^0-9])2([^0-9]|$)/.test(asciiClinic);
        const isDental4 = isDentalWord && /(^|[^0-9])4([^0-9]|$)/.test(asciiClinic);
        const isDental5 = isDentalWord && /(^|[^0-9])5([^0-9]|$)/.test(asciiClinic);
        const isDerm = /الجلدية|التجميل/.test(baseClinicName);
        const isSkinClean = /(تنظيف.?البشرة|هايدرافيشل|التشقير)/i.test(baseClinicName);
        const between = (t, h1, m1, h2, m2) => {
          const m = timeToMinutes(t);
          const s = h1*60 + m1, e = h2*60 + m2;
          return m >= s && m <= e;
        };
        if (isDental1 || isDental2) { filtered = raw.filter(x => x.time24 && between(x.time24, 16, 0, 20, 30)); return; }
        if (isDental4) { filtered = raw.filter(x => x.time24 && between(x.time24, 14, 0, 21, 30)); return; }
        if (isDental5) { filtered = raw.filter(x => x.time24 && between(x.time24, 12, 0, 19, 30)); return; }
        if (isDerm)   { filtered = raw.filter(x => x.time24 && between(x.time24, 15, 0, 21, 30)); return; }
        if (isSkinClean){ filtered = raw.filter(x => x.time24 && between(x.time24, 15, 30, 21, 30)); return; }
      })();

      if (shouldBlockFriSat) {
        const isFriOrSat = (dateStr)=> {
          const [Y,M,D] = (dateStr||'').split('-').map(n=>+n);
          if(!Y||!M||!D) return false;
          const wd = new Date(Date.UTC(Y, M-1, D)).getUTCDay(); // 5=جمعة 6=سبت
          return wd === 5 || wd === 6;
        };
        filtered = filtered.filter(x => !isFriOrSat(x.date));
      }

      // ====== (الأهم) فلترة السلاسل المتتالية بحسب chainLen (15 دقيقة لكل خانة) ======
      const byDate = {};
      for (const it of filtered) {
        byDate[it.date] = byDate[it.date] || [];
        byDate[it.date].push(it);
      }
      Object.values(byDate).forEach(list => list.sort((a,b)=> timeToMinutes(a.time24)-timeToMinutes(b.time24)));

      const starters = [];
      for (const [date, list] of Object.entries(byDate)) {
        for (let i=0; i<list.length; i++){
          let ok = true;
          for (let k=1; k<chainLen; k++){
            const needTime = addMinutes(list[i].time24, 15*k);
            const exists = list.find(x => x.time24 === needTime);
            if (!exists) { ok=false; break; }
          }
          if (ok) starters.push(list[i]);
        }
      }

      const times = starters.map(x => ({
        value: x.value,
        label: `${x.date} - ${(() => { // to12h
          let [H,M='0']=x.time24.split(':'); H=+H; M=String(+M).padStart(2,'0');
          const am=H<12; let h=H%12; if(h===0) h=12; return `${h}:${M} ${am?'ص':'م'}`;
        })()}`
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

/** ===== Booking flow (يدعم حجز سلسلة متتالية) ===== */
async function bookNow({ identity, name, phone, clinic, month, time, note, needChainMin, account }){
  const chainLen = Math.max(1, Math.ceil((Number(needChainMin)||30) / 15)); // 15 دقيقة كوحدة
  const [datePart, timeStart] = String(time||'').split('*');
  if (!datePart || !timeStart) return '❌ فشل الحجز: الوقت غير صالح';

  const browser = await launchBrowserSafe();
  const page = await browser.newPage(); await prepPage(page);
  try{
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

    // شهر واحد
    await applyOneMonthView(page);

    // اختر الشهر
    const months = await page.evaluate(()=>Array.from(document.querySelectorAll('#month1 option')).map(o=>({value:o.value,text:(o.textContent||'').trim()})));
    const monthValue = months.find(m => m.text === month || m.value === month)?.value;
    if(!monthValue) throw new Error('لم يتم العثور على الشهر المطلوب!');
    await Promise.all([
      page.waitForNavigation({waitUntil:'domcontentloaded', timeout:120000}),
      page.select('#month1', monthValue)
    ]);

    // ابحث بالمفتاح (هوية أولاً ثم الاسم)
    const searchKey = (identity && String(identity).trim()) || (name && normalizeArabic(name)) || '';
    if (!searchKey) throw new Error('لا يوجد مفتاح بحث (هوية/اسم)!');
    await typeSlow(page, '#SearchBox120', searchKey, 120);

    // اختر المريض وفق الجوال إن أمكن
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
        picked = true; break;
      }
      await page.evaluate(()=>{ const el=document.querySelector('#SearchBox120'); if(el){['input','keyup','keydown','change'].forEach(ev=> el.dispatchEvent(new Event(ev,{bubbles:true})));} });
      await sleep(250);
    }
    if (!picked) {
      const fallback = await pickFirstSuggestionOnAppointments(page, 3000);
      if (!fallback) throw new Error('تعذر اختيار المريض من قائمة الاقتراحات!');
    }

    // عبئ الهاتف/الملاحظات
    await page.$eval('input[name="phone"]', (el,v)=>{ el.value=v; }, toLocal05(phone));
    if (typeof note === 'string' && note.trim()) {
      await page.$eval('input[name="notes"]', (el,v)=>{ el.value=v; }, note.trim());
    } else {
      await page.$eval('input[name="notes"]', (el)=>{ el.value=''; });
    }

    // ثوابت مطلوبة من النظام
    await page.select('select[name="gender"]', '1');
    await page.select('select[name="nation_id"]', '1');

    // ===== حجز سلسلة متتابعة =====
    for (let k=0; k<chainLen; k++){
      const t = addMinutes(timeStart, 15*k);
      const valueWanted = `${datePart}*${t}`;

      // اختر الراديو
      const selected = await page.evaluate((wanted)=>{
        const radios=document.querySelectorAll('input[type="radio"][name="ss"]');
        for(const r of radios){
          if(r.value===wanted && !r.disabled){ r.click(); return true; }
        }
        return false;
      }, valueWanted);
      if(!selected) throw new Error(`الوقت غير متاح الآن: ${valueWanted}`);

      // اضغط زر الحجز
      const pressed = await page.evaluate(()=>{
        const btn=Array.from(document.querySelectorAll('input[type="submit"][name="submit"]'))
          .find(el=>el.value && el.value.trim()==='حجز : Reserve');
        if(!btn) return false;
        btn.disabled=false; btn.removeAttribute('disabled'); btn.click(); return true;
      });
      if(!pressed) throw new Error('زر الحجز غير متاح!');

      // انتظر النافذة ثم أغلقها إن وُجدت
      await page.waitForSelector('#popupContact', { visible:true, timeout:15000 }).catch(()=>null);
      await page.evaluate(()=>{ const c=document.querySelector('#popupContactClose,#popupContact .close'); if(c) c.click(); }).catch(()=>{});
      await sleep(400);

      // بعد كل حجز، ابقَ على نفس الصفحة (غالبًا لا تُحدث)
      // لو تم توجيه الصفحة، نرجع لعرض المواعيد لنفس اليوم/الشهر (حماية)
      const stillOn = await page.evaluate(()=> /appoint_display\.php/.test(location.href)).catch(()=>true);
      if (!stillOn) {
        await gotoAppointments(page);
        // إعادة تهيئة العيادة/الشهر سريعًا
        await page.select('#clinic_id', clinicValue).catch(()=>{});
        await page.select('#month1', monthValue).catch(()=>{});
        await sleep(500);
      }
    }

    await browser.close();
    return `✅ تم الحجز بنجاح (${chainLen} خانة متتالية) بالحساب: ${account.user}`;
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
  METRICS = loadMetrics();
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
