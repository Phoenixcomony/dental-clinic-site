// lab-server.js
// ===============================================
// Phoenix Clinic - Lab Uploader (Standalone Server)
// - واجهة بسيطة للطبيب لرفع نتائج "الفيتامينات" PDF
// - دخول إلى نظام إمداد ورفع المرفق للمريض حسب رقم الملف
// - بعد نجاح الرفع: إرسال النتيجة على واتساب للعميل
// ===============================================

/**
 * تشغيل:
 *   PORT_LAB=3100 \
 *   IMDAD_USER=9090909090 IMDAD_PASS=9090909090 \
 *   INSTANCE_ID=... ACCESS_TOKEN=... \
 *   WHATS_FORWARD_MODE=document \
 *   node lab-server.js
 *
 * ملاحظات:
 * - يركّز الآن على مسار "الفيتامينات" (cat_id=3256) للاختبار كما طلبت.
 * - يرسل واتساب كمستند PDF (document) مع fallback للنص/الرابط إذا فشل send document.
 * - يحفظ الملفات مؤقتًا داخل مجلد ./labs ويرسل رابطًا عامًا لو احتجنا.
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ====== إعدادات عامة ======
process.env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || '/tmp';
process.env.LANG = process.env.LANG || 'ar_SA.UTF-8';

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// ====== تخزين ملفات المختبر (PDF) ======
const LABS_DIR = process.env.LABS_DIR || path.join(__dirname, 'labs');
try { fs.mkdirSync(LABS_DIR, { recursive: true }); } catch (_e) {}

function sanitizeFilename(name='') {
  const base = path.basename(name).replace(/[^\p{L}\p{N}\.\-\_ ]/gu, '').trim() || 'file';
  return base.slice(0, 80);
}
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, LABS_DIR),
  filename: (_req, file, cb) => {
    const id = crypto.randomBytes(6).toString('hex');
    const safe = sanitizeFilename(file.originalname);
    const ext = path.extname(safe) || '.pdf';
    const base = path.basename(safe, ext) || 'file';
    cb(null, `${Date.now()}_${id}_${base}${ext}`.replace(/\s+/g, '_'));
  }
});
const upload = multer({
  storage,
  limits: {
    fileSize: (Number(process.env.LAB_MAX_MB || 10)) * 1024 * 1024 // افتراضي 10MB
  },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'application/pdf';
    if (ok) return cb(null, true);
    return cb(new Error('يُسمح فقط بملفات PDF للاختبار.'));
  }
});

// إتاحة روابط تحميل (بدون فهرسة)
app.use('/lab-files', express.static(LABS_DIR, { index: false, dotfiles: 'deny', redirect: false }));

// ====== إعداد واتساب ======
const INSTANCE_ID = process.env.INSTANCE_ID || 'CHANGE_ME';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || 'CHANGE_ME';
const WHATS_FORWARD_MODE = (process.env.WHATS_FORWARD_MODE || 'document').toLowerCase();
const WHATS_DOC_CAPTION_PREFIX = process.env.WHATS_DOC_CAPTION_PREFIX || 'نتائج التحليل - Phoenix Clinic';

// ====== إعداد Puppeteer ======
const BASE_URL = process.env.IMDAD_BASE_URL || 'https://phoenix.imdad.cloud/medica13/';
const IMDAD_USER = process.env.IMDAD_USER || '9090909090';
const IMDAD_PASS = process.env.IMDAD_PASS || '9090909090';
const PUPPETEER_PROTOCOL_TIMEOUT_MS = Number(process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS || 180000);
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

// ====== أدوات مساعدة ======
function toAsciiDigits(s='') {
  const map = {'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'};
  return String(s).replace(/[٠-٩]/g, d => map[d] || d);
}
function normalizePhoneIntl(v=''){
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
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

// ====== دخول النظام ======
async function loginToImdad(page){
  await page.goto(`${BASE_URL}login.php?a=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name="username"]', { timeout: 30000 });
  await page.$eval('input[name="username"]', (el,v)=>{el.value=v;}, IMDAD_USER);
  await page.$eval('input[name="password"]', (el,v)=>{el.value=v;}, IMDAD_PASS);
  await Promise.race([
    page.waitForNavigation({waitUntil:'domcontentloaded', timeout: 30000}),
    page.click('#submit')
  ]).catch(()=>{});
  const ok = await page.waitForSelector('#navbar-search-input, a[href*="appoint_display.php"]', { timeout: 15000 })
    .then(()=>true).catch(()=>false);
  if (!ok) throw new Error('فشل تسجيل الدخول (IMDAD)');
}

// ====== رفع نتيجة "الفيتامينات" لمريض برقم ملف + استخراج جواله ======
const CAT_VITAMINS = process.env.CAT_VITAMINS || '3256'; // حسب مثالك

async function uploadVitaminPdfAndGetPhone({ fileId, pdfPath }) {
  const browser = await launchBrowserSafe();
  const page = await browser.newPage(); await prepPage(page);

  try {
    await loginToImdad(page);

    // 1) اذهب إلى صفحة نتائج المريض مباشرة بالـ sid
    await page.goto(`${BASE_URL}ana_display.php?sid=${encodeURIComponent(String(fileId))}`, { waitUntil: 'domcontentloaded' });

    // 2) افتح رابط الفيتامينات (cat_id ثابت للاختبار)
    const catSel = `a[href*="ana_result.php?cat_id=${CAT_VITAMINS}"]`;
    const catFound = await page.waitForSelector(catSel, { timeout: 20000 }).then(()=>true).catch(()=>false);
    if (!catFound) throw new Error('لم يتم العثور على رابط تحليل الفيتامينات');

    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{}),
      page.click(catSel)
    ]);

    // 3) افتح "Upload Attachments"
    const uploadLinkSel = 'a[href^="rec_pict.php?st_ana_id="]';
    const upFound = await page.waitForSelector(uploadLinkSel, { timeout: 20000 }).then(()=>true).catch(()=>false);
    if (!upFound) throw new Error('لم يتم العثور على رابط Upload Attachments');
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{}),
      page.click(uploadLinkSel)
    ]);

    // 4) ارفع ملف PDF عبر input#file ثم اضغط Upload
    const fileInput = await page.waitForSelector('#file', { timeout: 20000 });
    await fileInput.uploadFile(pdfPath);

    // أحيانًا يحتاج تأخير بسيط قبل زر الرفع
    await sleep(400);

    const submitSel = '#submit[name="submit"]';
    const canClick = await page.$(submitSel);
    if (!canClick) throw new Error('زر Upload غير موجود');
    await page.click(submitSel);

    // 5) تأكيد النجاح: ظهور Back أو Back to Waiting List
    const okBack = await Promise.race([
      page.waitForSelector('a[href*="ana_result.php?cat_id="]', { timeout: 20000 }).then(()=>true).catch(()=>false),
      page.waitForFunction(() => {
        const txt = (document.body.innerText||'').replace(/\s+/g,' ');
        return /Back to Waiting List/i.test(txt);
      }, { timeout: 20000 }).then(()=>true).catch(()=>false)
    ]);
    if (!okBack) throw new Error('لم يتم تأكيد الرفع (لا يوجد Back/Back to Waiting List)');

    // 6) استخراج رقم الجوال عبر سطر medical_report
    //    إن لم يظهر في الصفحة الحالية، ارجع للعرض العام للنتائج
    async function extractPhoneHere() {
      return await page.evaluate(()=>{
        function toAscii(s){const map={'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'};return String(s).replace(/[٠-٩]/g, d=>map[d]||d);}
        const bodyText = toAscii((document.body.innerText||'')).replace(/\s+/g,' ');
        const m = bodyText.match(/0?5\d{8}/);
        return m ? m[0] : '';
      });
    }
    let local05 = await extractPhoneHere();

    if (!local05) {
      // رجوع لصفحة النتائج الخاصة بالمريض ثم عرض medical_report
      await page.goto(`${BASE_URL}ana_display.php?sid=${encodeURIComponent(String(fileId))}`, { waitUntil: 'domcontentloaded' }).catch(()=>{});
      // ابحث عن السطر الذي يحتوي medical_report + الهاتف
      local05 = await extractPhoneHere();
    }
    if (!local05) {
      // كحل أخير: افتح تقرير المريض (قد يكون بجانبه الهاتف)
      const medLinkSel = 'a[href^="medical_report.php?st_id="]';
      const hasMed = await page.$(medLinkSel);
      if (hasMed) {
        await Promise.race([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(()=>{}),
          page.click(medLinkSel)
        ]).catch(()=>{});
        local05 = await extractPhoneHere();
      }
    }

    await browser.close();

    return {
      success: true,
      phoneLocal: local05 || '',
    };

  } catch (e) {
    try { await browser.close(); } catch(_){}
    return { success: false, error: e?.message || String(e) };
  }
}

// ====== إرسال واتساب ======
async function sendWhatsLinkOrDocument({ phoneLocal, fileUrl, fileName, caption }) {
  const intl = normalizePhoneIntl(phoneLocal);
  if (!/^9665\d{8}$/.test(intl)) {
    throw new Error('رقم الجوال غير صحيح لإرسال واتساب');
  }
  const cap = caption || `${WHATS_DOC_CAPTION_PREFIX}\n${fileName || ''}`;

  if (!INSTANCE_ID || !ACCESS_TOKEN || INSTANCE_ID==='CHANGE_ME' || ACCESS_TOKEN==='CHANGE_ME') {
    throw new Error('إعدادات واتساب غير مهيأة (ENV)');
  }

  // الوضع الافتراضي: document (مع fallback إلى نص/رابط)
  if (WHATS_FORWARD_MODE === 'document') {
    try {
      const docUrl =
        `https://mywhats.cloud/api/send?number=${intl}&type=document&file_url=${encodeURIComponent(fileUrl)}&filename=${encodeURIComponent(fileName||'report.pdf')}&caption=${encodeURIComponent(cap)}&instance_id=${INSTANCE_ID}&access_token=${ACCESS_TOKEN}`;
      await axios.get(docUrl, { timeout: 20000 });
      return { mode: 'document' };
    } catch (_e) {
      // fallback: أرسل رابطًا نصيًا
      const msg = `${cap}\n${fileUrl}`;
      const textUrl =
        `https://mywhats.cloud/api/send?number=${intl}&type=text&message=${encodeURIComponent(msg)}&instance_id=${INSTANCE_ID}&access_token=${ACCESS_TOKEN}`;
      await axios.get(textUrl, { timeout: 15000 });
      return { mode: 'link-fallback' };
    }
  } else {
    // إرسال كرابط نصّي مباشرة
    const msg = `${cap}\n${fileUrl}`;
    const textUrl =
      `https://mywhats.cloud/api/send?number=${intl}&type=text&message=${encodeURIComponent(msg)}&instance_id=${INSTANCE_ID}&access_token=${ACCESS_TOKEN}`;
    await axios.get(textUrl, { timeout: 15000 });
    return { mode: 'link' };
  }
}

// ====== واجهة بسيطة للطبيب ======
app.get('/lab', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phoenix Lab Uploader</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,Tahoma,Arial; background:#f7f7f9; color:#222; padding:24px;}
  .card{max-width:640px; margin:0 auto; background:#fff; border:1px solid #eee; border-radius:14px; padding:20px; box-shadow:0 6px 16px rgba(0,0,0,.06);}
  label{display:block; margin:12px 0 6px;}
  input[type="text"], select, input[type="number"]{width:100%; padding:10px 12px; border:1px solid #ddd; border-radius:10px; font-size:16px;}
  input[type="file"]{margin-top:8px;}
  button{margin-top:16px; background:#0e7b5f; color:#fff; padding:12px 16px; border:none; border-radius:10px; font-weight:600; cursor:pointer;}
  button:disabled{opacity:.6; cursor:not-allowed;}
  .muted{color:#666; font-size:13px;}
</style>
</head>
<body>
  <div class="card">
    <h2 style="margin-top:0">رفع نتيجة - المختبر (تجربة الفيتامينات)</h2>
    <form action="/lab/upload" method="post" enctype="multipart/form-data">
      <label>نوع التحليل</label>
      <select name="analysis" required>
        <option value="vitamins" selected>الفيتامينات</option>
        <option value="chem" disabled>الكيمياويات (لاحقًا)</option>
      </select>

      <label>رقم ملف المريض (sid)</label>
      <input type="number" name="fileId" inputmode="numeric" placeholder="مثال: 12380" required>

      <label>ملف النتيجة (PDF فقط)</label>
      <input type="file" name="pdf" accept="application/pdf" required>

      <p class="muted">سيتم رفع الملف في إمداد ثم إرسال النتيجة عبر واتساب للمريض تلقائيًا.</p>

      <button type="submit">رفع وإرسال</button>
    </form>
  </div>
</body>
</html>`);
});

// ====== طابور تنفيذ لعدم تضارب جلسات Puppeteer ======
const jobQueue = [];
let processing = false;
async function runQueue() {
  if (processing || !jobQueue.length) return;
  processing = true;
  const { req, res } = jobQueue.shift();

  try {
    const result = await handleUploadJob(req);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success:false, error: e?.message || String(e) });
  } finally {
    processing = false;
    runQueue();
  }
}

// ====== REST: استقبال الرفع من الواجهة ======
app.post('/lab/upload', upload.single('pdf'), (req, res) => {
  jobQueue.push({ req, res });
  runQueue();
});

// ====== منطق عملية الرفع الكاملة ======
async function handleUploadJob(req) {
  const { analysis, fileId } = req.body || {};
  const pdfFile = req.file;

  if (!pdfFile) return { success:false, error:'لم يتم استلام ملف PDF' };
  if (!fileId || String(fileId).trim() === '') return { success:false, error:'رقم الملف مطلوب' };

  if (analysis !== 'vitamins') return { success:false, error:'التحليل المدعوم الآن: الفيتامينات فقط' };

  const pdfPath = pdfFile.path;
  const fileUrl = `${(process.env.PUBLIC_BASE || '')}/lab-files/${encodeURIComponent(path.basename(pdfPath))}`.replace(/([^:]\/)\/+/g,'$1');
  const safeFileUrl = (process.env.PUBLIC_BASE ? fileUrl : `${req.protocol}://${req.get('host')}/lab-files/${encodeURIComponent(path.basename(pdfPath))}`);

  // 1) ارفع الملف داخل إمداد
  const up = await uploadVitaminPdfAndGetPhone({ fileId: String(fileId).trim(), pdfPath });
  if (!up.success) {
    return { success:false, stage:'upload', error: up.error || 'فشل الرفع داخل النظام' };
  }

  // 2) إرسال واتساب (كمستند مع fallback)
  const phoneLocal = up.phoneLocal || '';
  if (!/^(0)?5\d{8}$/.test(phoneLocal)) {
    return { success:false, stage:'whatsapp', warning:'تم الرفع بنجاح، لكن تعذّر استخراج رقم الجوال لإرسال واتساب.', phoneLocal };
  }

  let wa;
  try {
    wa = await sendWhatsLinkOrDocument({
      phoneLocal,
      fileUrl: safeFileUrl,
      fileName: path.basename(pdfPath),
      caption: `${WHATS_DOC_CAPTION_PREFIX}`
    });
  } catch (e) {
    return {
      success:false,
      stage:'whatsapp',
      error: e?.message || 'فشل إرسال واتساب',
      phoneLocal,
      fileUrl: safeFileUrl
    };
  }

  return {
    success:true,
    message:'تم رفع النتيجة في النظام وإرسالها عبر واتساب',
    phoneLocal,
    whatsappMode: wa?.mode || 'unknown',
    filePublicUrl: safeFileUrl
  };
}

// ====== Health ======
app.get('/lab/health', (_req,res)=> res.json({
  ok:true,
  time:new Date().toISOString(),
  chrome:CHROMIUM_PATH||'bundled',
  baseCacheDir: BASE_DL_DIR,
  baseUrl: BASE_URL,
  mode: WHATS_FORWARD_MODE
}));

// ====== بدء السيرفر ======
const PORT = process.env.PORT_LAB || 3100;
app.listen(PORT, '0.0.0.0', ()=> {
  console.log(`Lab server running on http://0.0.0.0:${PORT}  (chrome=${CHROMIUM_PATH||'bundled'})`);
});
