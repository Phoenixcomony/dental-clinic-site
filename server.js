// server.js
// ===============================
// Phoenix Clinic - Backend Server (with Live Monitor / Snapshots)
// ===============================

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));
app.use(express.static(__dirname));

/** ===== ENV =====
 * INSTANCE_ID / ACCESS_TOKEN: mywhats.cloud credentials
 * SKIP_OTP_FOR_TESTING=true لتجاوز OTP في التطوير (لا تستخدمها في الإنتاج)
 * DEBUG_BROWSER=1 لفتح المتصفح بصريًا (headful)
 * DEBUG_CAPTURE=1 لتفعيل التقاط اللقطات وعرض صفحة المراقبة
 */
const INSTANCE_ID = process.env.INSTANCE_ID || 'CHANGE_ME';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || 'CHANGE_ME';
const SKIP_OTP_FOR_TESTING = process.env.SKIP_OTP_FOR_TESTING === 'true';
const DEBUG_BROWSER = process.env.DEBUG_BROWSER === '1';
const DEBUG_CAPTURE = process.env.DEBUG_CAPTURE === '1';

// مهلة بروتوكول كروم لمنع Runtime.callFunctionOn timed out
const PUPPETEER_PROTOCOL_TIMEOUT_MS = 180000; // 3 دقائق

/** ===== Debug: recent logs + snapshots ===== */
const recentLogs = [];
const origLog = console.log;
console.log = (...args) => {
  const line = new Date().toISOString() + ' ' + args.map(a => {
    try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  recentLogs.push(line);
  if (recentLogs.length > 800) recentLogs.shift();
  origLog(...args);
};

const CAP_DIR = path.join(__dirname, 'debug_shots');
if (DEBUG_CAPTURE) {
  try { fs.mkdirSync(CAP_DIR, { recursive: true }); } catch {}
}
async function snap(page, tag) {
  if (!DEBUG_CAPTURE) return;
  try {
    const safe = String(tag || 'shot').replace(/[^\w\-\.]+/g, '_').slice(0, 80);
    const base = Date.now() + '-' + safe;
    await page.screenshot({ path: path.join(CAP_DIR, `${base}.png`), fullPage: true });
    const html = await page.content();
    fs.writeFileSync(path.join(CAP_DIR, `${base}.html`), html);
    console.log('[SNAP]', base);
  } catch (e) {
    console.log('[SNAP-ERR]', e?.message || e);
  }
}
// Routes for monitor
app.get('/debug/logs', (_req, res) => {
  res.type('text/plain').send(recentLogs.join('\n'));
});
app.get('/debug/shots', (_req, res) => {
  if (!DEBUG_CAPTURE) return res.json([]);
  try {
    const files = fs.readdirSync(CAP_DIR).filter(f => f.endsWith('.png'))
      .map(f => ({ f, ts: Number(f.split('-')[0]) || 0 }))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 40) // آخر 40 لقطة
      .map(x => x.f);
    res.json(files);
  } catch {
    res.json([]);
  }
});
app.get('/debug/shots/:file', (req, res) => {
  if (!DEBUG_CAPTURE) return res.status(404).end();
  const p = path.join(CAP_DIR, path.basename(req.params.file));
  if (!fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});
app.get('/monitor', (_req, res) => {
  // صفحة مراقبة بسيطة تعرض اللقطات واللوجات (تتحدث كل 4 ثواني)
  res.type('html').send(`<!doctype html>
<html dir="rtl" lang="ar">
<head>
<meta charset="utf-8"/>
<title>Monitor</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{font-family:system-ui,Segoe UI,Tahoma,Arial; background:#0b0b10; color:#eee; margin:0; padding:16px;}
  h1{font-size:20px;margin:0 0 12px}
  .wrap{display:grid; grid-template-columns: 1fr 320px; gap:12px;}
  .shots{display:grid; grid-template-columns: repeat(auto-fill,minmax(280px,1fr)); gap:10px; align-content:start; max-height:80vh; overflow:auto; border:1px solid #222; padding:8px; border-radius:10px;}
  .shots img{width:100%; border-radius:8px; display:block; background:#111}
  .panel{display:flex; flex-direction:column; gap:8px;}
  .logs{white-space:pre-wrap; background:#111; color:#b7c4ff; padding:8px; border-radius:8px; height:80vh; overflow:auto; border:1px solid #222;}
  a{color:#8ab4f8}
  .hint{opacity:.7}
</style>
</head>
<body>
  <h1>📺 Live Monitor</h1>
  <div class="hint">تأكّد من ضبط <code>DEBUG_CAPTURE=1</code>. اللقطات تتحدّث تلقائيًا.</div>
  <div class="wrap">
    <div>
      <div class="shots" id="shots"></div>
    </div>
    <div class="panel">
      <div><a href="/debug/logs" target="_blank">فتح اللوجات في تبويب جديد</a></div>
      <div class="logs" id="logs">Loading logs…</div>
    </div>
  </div>
<script>
async function refresh() {
  try{
    const list = await (await fetch('/debug/shots')).json();
    const shots = document.getElementById('shots');
    shots.innerHTML = list.map(f=>\`<a href="/debug/shots/\${f}" target="_blank"><img loading="lazy" src="/debug/shots/\${f}" alt="\${f}"/></a>\`).join('');
  }catch(e){}
  try{
    const txt = await (await fetch('/debug/logs')).text();
    const el = document.getElementById('logs');
    el.textContent = txt;
    el.scrollTop = el.scrollHeight;
  }catch(e){}
}
setInterval(refresh, 4000);
refresh();
</script>
</body>
</html>`);
});

/** ===== Chromium path detection ===== */
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
  return null; // use bundled Chromium
}
const CHROMIUM_PATH = resolveChromePath();
console.log('Using Chromium path:', CHROMIUM_PATH || '(bundled by puppeteer)');

/** ===== Imdad accounts (rotating) ===== */
const ACCOUNTS = [
  { user: "1111111111", pass: "1111111111", busy: false },
  { user: "2222222222", pass: "2222222222", busy: false },
  { user: "3333333333", pass: "3333333333", busy: false },
  { user: "5555555555", pass: "5555555555", busy: false },
];
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
async function acquireAccount() {
  while (true) {
    const i = ACCOUNTS.findIndex(a => !a.busy);
    if (i !== -1) { ACCOUNTS[i].busy = true; return ACCOUNTS[i]; }
    await sleep(200);
  }
}
async function acquireAccountWithTimeout(ms=20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const i = ACCOUNTS.findIndex(a => !a.busy);
    if (i !== -1) { ACCOUNTS[i].busy = true; return ACCOUNTS[i]; }
    await sleep(150);
  }
  throw new Error('imdad_busy');
}
function releaseAccount(a){ const i = ACCOUNTS.findIndex(x=>x.user===a.user); if(i!==-1) ACCOUNTS[i].busy=false; }

/** ===== Helpers ===== */
function normalizeArabic(s=''){ return (s||'').replace(/\s+/g,' ').trim(); }
function toAsciiDigits(s='') {
  const map = {'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'};
  return String(s).replace(/[٠-٩]/g, d => map[d] || d);
}
function isTripleName(n){
  return normalizeArabic(n).split(' ').filter(Boolean).length === 3;
}
function isSaudi05(v){
  const d = toAsciiDigits(v||'').replace(/\D/g,'');
  return /^05\d{8}$/.test(d);
}
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
  const A = toLocal05(a||'').replace(/\D/g,'');
  const B = toLocal05(b||'').replace(/\D/g,'');
  return A && B && A === B;
}
function extractFileId(str=''){
  const m = toAsciiDigits(str).match(/\b(\d{3,})\b/);
  return m ? m[1] : '';
}
function parseSuggestionText(txt=''){
  const raw = normalizeArabic(txt);
  const parts = raw.split('*').map(s=>normalizeArabic(s));
  const tokens = parts.length > 1 ? parts : raw.split(/[-|،,]+/).map(s=>normalizeArabic(s));
  let name='', phone='', fileId='';
  for(const t of tokens){
    const td = toAsciiDigits(t);
    const digits = td.replace(/\D/g,'');
    if(/^05\d{8}$/.test(digits) || /^9665\d{8}$/.test(digits) || /^5\d{8}$/.test(digits)){
      if(!phone) phone = digits; continue;
    }
    if(/\d{3,}/.test(digits) && !/^0?5\d{8}$/.test(digits) && !/^9665\d{8}$/.test(digits)){
      if(!fileId) fileId = digits; continue;
    }
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

/** ===== Puppeteer setup ===== */
function launchOpts(){
  return {
    executablePath: CHROMIUM_PATH || undefined,
    headless: !DEBUG_BROWSER,
    ignoreHTTPSErrors: true,
    devtools: DEBUG_BROWSER,
    slowMo: DEBUG_BROWSER ? 40 : 0,
    protocolTimeout: PUPPETEER_PROTOCOL_TIMEOUT_MS,
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-gpu','--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding',
      '--disable-background-networking',
      DEBUG_BROWSER ? '--start-maximized' : '--window-size=1280,900',
      '--lang=ar-SA,ar,en-US,en',
      '--disable-features=IsolateOrigins,site-per-process'
    ]
  };
}
async function prepPage(page){
  await page.setViewport({ width: 1280, height: 900 });
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(120000);
  await page.setExtraHTTPHeaders({ 'Accept-Language':'ar-SA,ar;q=0.9,en;q=0.8' });
  await page.emulateTimezone('Asia/Riyadh').catch(()=>{});
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36');
}
async function loginToImdad(page, {user, pass}){
  console.log('[IMDAD] opening login…');
  await page.goto('https://phoenix.imdad.cloud/medica13/login.php?a=1', { waitUntil: 'networkidle2' });
  await snap(page, 'login-page');
  await page.$eval('input[name="username"]', (el,v)=>{el.value=v;}, user);
  await page.$eval('input[name="password"]', (el,v)=>{el.value=v;}, pass);
  await Promise.all([ page.waitForNavigation({waitUntil:'networkidle2', timeout:120000}), page.click('#submit') ]);
  await snap(page, 'after-login');
  console.log('[IMDAD] logged in.');
}
async function gotoAppointments(page){
  console.log('[IMDAD] goto appointments…');
  await page.goto('https://phoenix.imdad.cloud/medica13/appoint_display.php', { waitUntil:'networkidle2' });
  await snap(page, 'appointments');
}

/** ===== Utilities used by multiple bots ===== */
async function typeSlow(page, selector, text, perCharDelay = 120) {
  await page.waitForSelector(selector, { visible: true, timeout: 30000 });
  await page.focus(selector);
  await page.$eval(selector, el => { el.value = ''; });
  for (const ch of text) { await page.type(selector, ch, { delay: perCharDelay }); }
  await page.evaluate((sel)=>{
    const el = document.querySelector(sel);
    if(!el) return;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
  }, selector);
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

/** ===== Search by full name → open patient ===== */
async function searchAndOpenPatientByName(page, fullName) {
  console.log('[IMDAD] searching by name…', fullName);
  const selector = '#navbar-search-input, input[name="name122"]';

  await page.evaluate(()=>{ const el = document.querySelector('#navbar-search-input, input[name="name122"]'); if (el) el.value = ''; });
  await typeSlow(page, selector, fullName, 120);
  await snap(page, 'typed-name');

  const started = Date.now();
  let items = [];
  while (Date.now() - started < 12000) {
    items = await page.evaluate(()=>{
      const lis = Array.from(document.querySelectorAll('li[onclick^="fillSearch12"]'));
      return lis.map((li,idx)=>({ idx, text:(li.innerText||'').trim() }));
    });
    if (items.length) break;
    await page.evaluate((sel)=>{
      const el = document.querySelector(sel);
      if(!el) return;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
      el.blur(); el.focus();
    }, selector);
    await sleep(300);
  }

  if (!items.length) {
    await snap(page, 'no-suggestions');
    console.log('[IMDAD] fallback: no rows matched.');
    // فallback: حاول الذهاب مباشرة لنتيجة البحث (إن كان النظام يعرض لينك بطاقة)
    const patientHrefFallback = await page.evaluate(()=>{
      const a1 = document.querySelector('a[href^="stq_search2.php?id="]');
      if (a1) return a1.getAttribute('href');
      const icon = document.querySelector('a i.far.fa-address-card');
      if (icon && icon.closest('a')) return icon.closest('a').getAttribute('href');
      return '';
    });
    if (patientHrefFallback) {
      await snap(page, 'fallback-patient-link');
      await page.goto(`https://phoenix.imdad.cloud/medica13/${patientHrefFallback}`, { waitUntil: 'networkidle2' });
      await snap(page, 'opened-patient-fallback');
      const fileIdFB = ((patientHrefFallback.match(/id=(\d+)/) || [])[1] || '');
      return { ok:true, pickedText:'(fallback)', fileId:fileIdFB, liPhone:'', liName: fullName };
    }
    return { ok: false, reason: 'no_suggestions' };
  }

  const targetName = normalizeArabic(fullName);
  let chosen = null;
  for (const it of items) {
    const parsed = parseSuggestionText(it.text);
    if (normalizeArabic(parsed.name) === targetName) { chosen = { ...it, parsed }; break; }
  }
  if (!chosen) { chosen = { ...items[0], parsed: parseSuggestionText(items[0].text) }; }

  await page.evaluate((i)=>{
    const lis = document.querySelectorAll('li[onclick^="fillSearch12"]');
    if(lis && lis[i]) lis[i].click();
  }, chosen.idx);

  await snap(page, 'picked-suggestion');

  const pickedText = chosen.text;
  const liParsed = chosen.parsed;
  const liName  = liParsed.name || '';
  let fileId    = liParsed.fileId || '';
  let liPhone   = liParsed.phone || '';

  const patientHref = await page.evaluate(()=>{
    const a1 = document.querySelector('a[href^="stq_search2.php?id="]');
    if (a1) return a1.getAttribute('href');
    const icon = document.querySelector('a i.far.fa-address-card');
    if (icon && icon.closest('a')) return icon.closest('a').getAttribute('href');
    return '';
  });

  if (!patientHref) {
    await snap(page, 'no-patient-link');
    console.log('[IMDAD] fallback failed to find patient link/id.');
    return { ok: false, reason: 'no_patient_link', pickedText, fileId, liPhone, liName };
  }

  const gotFileId = fileId || ((patientHref.match(/id=(\d+)/) || [])[1] || '');
  console.log('[IMDAD] open patient data. fileId=', gotFileId, 'href=', patientHref);
  await page.goto(`https://phoenix.imdad.cloud/medica13/${patientHref}`, { waitUntil: 'networkidle2' });
  await snap(page, 'opened-patient');

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

  return { ok: true, pickedText, fileId: gotFileId, liPhone, liName };
}

/** ===== Read identity (SSN) ===== */
async function readIdentityStatus(page, fileId) {
  console.log('[IMDAD] checking identity…');
  await page.goto(`https://phoenix.imdad.cloud/medica13/stq_edit.php?id=${fileId}`, { waitUntil: 'networkidle2' }).catch(()=>{});
  await snap(page, 'edit-file');

  try {
    await page.waitForSelector('#ssn', { timeout: 5000 });
    const ssnVal = await page.$eval('#ssn', el => (el.value || '').trim());
    const digits = toAsciiDigits(ssnVal).replace(/\D/g,'');
    const hasIdentity = !!(digits && !/^0+$/.test(digits) && digits.length >= 8 && !/^05\d{8}$/.test(digits));
    console.log('[IMDAD] hasIdentity(by #ssn)=', hasIdentity, 'ssnVal=', ssnVal);
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
      if (digits && !/^0+$/.test(digits) && digits.length >= 8) { return digits; }
    }
    return '';
  });

  const digits = toAsciiDigits(ssnVal).replace(/\D/g,'');
  const hasIdentity = !!(digits && !/^0+$/.test(digits) && digits.length >= 8 && !/^05\d{8}$/.test(digits));
  console.log('[IMDAD] hasIdentity(by td)=', hasIdentity, 'ssnVal=', ssnVal);
  return { hasIdentity, ssnVal };
}

/** ===== API: /api/login ===== */
app.post('/api/login', async (req, res) => {
  try {
    const { name, phone, otp } = req.body || {};
    if(!isTripleName(name)) return res.status(200).json({ success:false, message:'الاسم يجب أن يكون ثلاثيًا' });
    if(!isSaudi05(phone))  return res.status(200).json({ success:false, message:'رقم الجوال بصيغة 05xxxxxxxx' });
    if(!verifyOtpInline(phone, otp)) return res.status(200).json({ success:false, message:'رمز التحقق غير صحيح', reason:'otp' });

    const browser = await puppeteer.launch(launchOpts());
    const page = await browser.newPage(); await prepPage(page);
    let account=null;
    try{
      account = await acquireAccount();
      await loginToImdad(page, account);
      await gotoAppointments(page);

      // اكتب الاسم ببطء، التقط لقطة قبل/بعد
      await typeSlow(page, '#navbar-search-input, input[name="name122"]', normalizeArabic(name), 120);
      await snap(page, 'login-typed-name');

      const searchRes = await searchAndOpenPatientByName(page, normalizeArabic(name));
      if(!searchRes.ok){
        console.log('[IMDAD] search result:', searchRes);
        await browser.close(); if(account) releaseAccount(account);
        return res.json({ success:false, exists:false, message:'لا تملك ملفًا لدينا. انقر (افتح ملف جديد).' });
      }

      const fileId = searchRes.fileId;
      const liPhone = searchRes.liPhone;

      if (!phonesEqual05(liPhone, phone)) {
        await browser.close(); if(account) releaseAccount(account);
        return res.json({ success:false, exists:true, reason:'phone_mismatch', message:'رقم الجوال غير متطابق مع الاسم' });
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

/** ===== Duplicate-phone detector ===== */
async function isDuplicatePhoneWarning(page){
  try {
    const found = await page.evaluate(()=>{
      const txt = (document.body.innerText||'').replace(/\s+/g,' ');
      return /رقم هاتف موجود يخص المريض\s*:/.test(txt) || /اسم مريض موجود بالفعل/.test(txt);
    });
    return !!found;
  } catch { return false; }
}

/** ===== API: /api/update-identity ===== */
app.post('/api/update-identity', async (req, res) => {
  try{
    const { fileId, nationalId, birthYear } = req.body || {};
    if(!fileId) return res.json({ success:false, message:'رقم الملف مفقود' });
    if(!nationalId) return res.json({ success:false, message:'رقم الهوية مطلوب' });
    if(!birthYear) return res.json({ success:false, message:'سنة الميلاد مطلوبة' });

    const browser = await puppeteer.launch(launchOpts());
    const page = await browser.newPage(); await prepPage(page);
    let account=null;
    try{
      account = await acquireAccount();
      await loginToImdad(page, account);

      await page.goto(`https://phoenix.imdad.cloud/medica13/stq_edit.php?id=${fileId}`, { waitUntil:'networkidle2' });
      await snap(page, 'update-identity-form');

      await page.waitForSelector('#ssn', { timeout: 10000 });
      await page.$eval('#ssn', (el,v)=>{ el.value=v; }, String(nationalId));
      await page.select('#year12', String(birthYear));

      await page.waitForSelector('#submit', { timeout: 20000 });
      await page.evaluate(() => {
        const btn = document.querySelector('#submit');
        if (btn) { btn.disabled=false; btn.removeAttribute('disabled'); btn.click(); }
      });

      await sleep(1500);
      await snap(page, 'update-identity-after-submit');
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

/** ===== API: /api/create-patient ===== */
app.post('/api/create-patient', async (req, res) => {
  const MASTER_TIMEOUT_MS = 60000;
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

      const browser = await puppeteer.launch(launchOpts());
      const page = await browser.newPage(); await prepPage(page);
      let account=null;
      try{
        account = await acquireAccountWithTimeout(20000);
        await loginToImdad(page, account);

        await page.goto('https://phoenix.imdad.cloud/medica13/stq_add.php', { waitUntil:'networkidle2' });
        await snap(page, 'new-file-form');

        await page.waitForSelector('#fname', { timeout: 30000 });
        await page.waitForSelector('#phone', { timeout: 30000 });

        await page.$eval('#fname', (el,v)=>{ el.value=v; }, _normalize(fullName));
        await page.$eval('#ssn', (el,v)=>{ el.value=v; }, String(nationalId));

        await page.select('#day12',   String(day));
        await page.select('#month12', String(month));
        await page.select('#year12',  String(year));
        await page.select('#gender',  String(gender));

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

        const localPhone = toLocal05(phone);
        async function typePhoneSlowAndEnsure(p){
          await page.$eval('#phone', (el)=>{ el.value=''; });
          for(let i=0;i<p.length;i++){
            const ch = p[i];
            const delay = i>=7 ? 140 : 100;
            await page.type('#phone', ch, { delay });
          }
          await sleep(300);
          const readBack = await page.$eval('#phone', el => (el.value||'').trim());
          const digits = toAsciiDigits(readBack).replace(/\D/g,'');
          if(!/^05\d{8}$/.test(digits)){
            await page.$eval('#phone', (el)=>{ el.value=''; });
            for(const ch of p){ await page.type('#phone', ch, { delay: 150 }); }
            await sleep(400);
          }
        }

        await typePhoneSlowAndEnsure(localPhone);
        await snap(page, 'new-file-phone-typed');

        await sleep(2000);
        await snap(page, 'new-file-after-2s');

        if (await isDuplicatePhoneWarning(page)) {
          await snap(page, 'new-file-dup-detected');
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
        await snap(page, 'new-file-submit-clicked');

        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(()=>{});
        await sleep(1500);

        if (await isDuplicatePhoneWarning(page)) {
          await snap(page, 'new-file-dup-after-submit');
          await browser.close(); if(account) releaseAccount(account);
          return res.json({
            success:false,
            reason:'phone_exists',
            message:'لديك ملف مسجل لدينا، الرجاء تسجيل الدخول'
          });
        }

        await snap(page, 'new-file-done');
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
    catch(_) {}
  });
});

/** ===== API: /api/times ===== */
app.post('/api/times', async (req, res) => {
  try {
    const { clinic, month } = req.body || {};
    if (!clinic || !month) return res.status(400).json({ times: [], error: 'العيادة أو الشهر مفقود' });

    const browser = await puppeteer.launch(launchOpts());
    const page = await browser.newPage(); await prepPage(page);
    try{
      await loginToImdad(page, { user:'1111111111', pass:'1111111111' });
      await gotoAppointments(page);

      const clinicValue = await page.evaluate((name) => {
        const opts = Array.from(document.querySelectorAll('#clinic_id option'));
        const f = opts.find(o => o.textContent.trim() === name);
        return f ? f.value : null;
      }, clinic);
      if(!clinicValue) throw new Error('لم يتم العثور على العيادة!');

      await Promise.all([ page.waitForNavigation({waitUntil:'networkidle2', timeout:120000}), page.select('#clinic_id', clinicValue) ]);

      const months = await page.evaluate(()=>Array.from(document.querySelectorAll('#month1 option')).map(o=>({value:o.value,text:o.textContent})));
      const monthValue = months.find(m => m.text === month || m.value === month)?.value;
      if(!monthValue) throw new Error('لم يتم العثور على الشهر المطلوب!');

      await Promise.all([ page.waitForNavigation({waitUntil:'networkidle2', timeout:120000}), page.select('#month1', monthValue) ]);

      const times = await page.evaluate(()=>{
        function p(t){ if(!t) return ''; const h=parseInt(t.split(':')[0],10); return h<12?'ص':'م'; }
        const out=[]; const radios=document.querySelectorAll('input[type="radio"][name="ss"]:not(:disabled)');
        for(const r of radios){ const value=r.value||''; const [date,time24]=value.split('*'); const label=time24?`${date} - ${time24} ${p(time24)}`:`${date}`; out.push({label,value}); }
        return out;
      });

      await snap(page, 'times-loaded');
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

/** ===== Booking flow ===== */
async function bookNow({ name, phone, clinic, month, time, account }){
  const browser = await puppeteer.launch(launchOpts());
  const page = await browser.newPage(); await prepPage(page);
  try{
    await loginToImdad(page, account);
    await gotoAppointments(page);

    const clinicValue = await page.evaluate((name) => {
      const opts = Array.from(document.querySelectorAll('#clinic_id option'));
      const f = opts.find(o => o.textContent.trim() === name);
      return f ? f.value : null;
    }, clinic);
    if(!clinicValue) throw new Error('لم يتم العثور على العيادة!');
    await Promise.all([ page.waitForNavigation({waitUntil:'networkidle2', timeout:120000}), page.select('#clinic_id', clinicValue) ]);

    const months = await page.evaluate(()=>Array.from(document.querySelectorAll('#month1 option')).map(o=>({value:o.value,text:o.textContent})));
    const monthValue = months.find(m => m.text === month || m.value === month)?.value;
    if(!monthValue) throw new Error('لم يتم العثور على الشهر المطلوب!');
    await Promise.all([ page.waitForNavigation({waitUntil:'networkidle2', timeout:120000}), page.select('#month1', monthValue) ]);

    await typeSlow(page, '#SearchBox120', normalizeArabic(name), 120);
    await snap(page, 'book-typed-name');
    const picked = await pickFirstSuggestionOnAppointments(page, 12000);
    if (!picked) throw new Error('تعذر اختيار المريض من قائمة الاقتراحات!');

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
    await snap(page, 'book-done');
    await browser.close();
    return '✅ تم الحجز بنجاح بالحساب: '+account.user;
  }catch(e){
    await browser.close();
    return '❌ فشل الحجز: '+(e?.message||'حدث خطأ غير متوقع');
  }
}

/** ===== Verify OTP ===== */
app.post('/verify-otp', (req,res)=>{
  let { phone, otp } = req.body || {};
  if(verifyOtpInline(phone, otp)){ delete otpStore[normalizePhoneIntl(phone)]; return res.json({ success:true }); }
  return res.json({ success:false, message:'رمز التحقق غير صحيح!' });
});

/** ===== Healthcheck ===== */
app.get('/health', (_req,res)=> res.json({
  ok:true,
  time:new Date().toISOString(),
  chrome:CHROMIUM_PATH||'bundled',
  debug:DEBUG_BROWSER,
  capture:DEBUG_CAPTURE
}));

/** ===== Start server ===== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', ()=> console.log(`Server running on http://0.0.0.0:${PORT} (debug=${DEBUG_BROWSER}, capture=${DEBUG_CAPTURE})`));
