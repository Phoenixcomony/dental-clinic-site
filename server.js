// server.js
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

// ====== بيئة التشغيل / المتغيرات الحساسة ======
const INSTANCE_ID = process.env.INSTANCE_ID || 'CHANGE_ME';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || 'CHANGE_ME';

// اجعل Railway يضبط هذا المتغير: PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

// (اختياري) ثبّت Node 18 في Railway: NIXPACKS_NODE_VERSION=18
// يفضل إضافة ملف .npmrc فيه: unsafe-perm=true

// ====== حسابات الدخول للنظام الخارجي ======
const ACCOUNTS = [
  { user: "1111111111", pass: "1111111111", busy: false },
  { user: "2222222222", pass: "2222222222", busy: false },
  { user: "3333333333", pass: "3333333333", busy: false },
  { user: "5555555555", pass: "5555555555", busy: false }
];

const bookingQueue = [];

// ====== أدوات مساعدة ======
function normalizePhone(phone) {
  phone = (phone || '').replace(/[^0-9]/g, '');
  if (phone.startsWith('05') && phone.length === 10) return '966' + phone.slice(1);
  if (phone.startsWith('5') && phone.length === 9) return '966' + phone;
  if (phone.startsWith('9665') && phone.length === 12) return phone;
  return phone;
}

async function acquireAccount() {
  while (true) {
    const idx = ACCOUNTS.findIndex(acc => !acc.busy);
    if (idx !== -1) {
      ACCOUNTS[idx].busy = true;
      return ACCOUNTS[idx];
    }
    await new Promise(res => setTimeout(res, 1000));
  }
}
function releaseAccount(account) {
  const idx = ACCOUNTS.findIndex(acc => acc.user === account.user);
  if (idx !== -1) ACCOUNTS[idx].busy = false;
}

// إعدادات إطلاق المتصفح موحدة
function getLaunchOptions() {
  return {
    executablePath: CHROMIUM_PATH, // مهم على Railway
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-networking',
      '--window-size=1200,900',
      '--window-position=0,0'
    ]
  };
}

// تهيئة الصفحة بشكل موحد
async function prepPage(page) {
  await page.setViewport({ width: 1200, height: 900 });
  page.setDefaultNavigationTimeout(30000);   // 30s
  page.setDefaultTimeout(30000);
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
  );
}

// ====== OTP عبر mywhats.cloud ======
const otpStore = {};
app.post('/send-otp', async (req, res) => {
  try {
    let { phone } = req.body || {};
    phone = normalizePhone(phone);

    if (!/^9665\d{8}$/.test(phone)) {
      return res.status(400).json({ success: false, message: "رقم الجوال غير صحيح" });
    }

    const otp = Math.floor(100000 + Math.random() * 900000);
    otpStore[phone] = otp;
    console.log("OTP to:", phone, "| code:", otp);

    if (!INSTANCE_ID || !ACCESS_TOKEN || INSTANCE_ID === 'CHANGE_ME' || ACCESS_TOKEN === 'CHANGE_ME') {
      return res.status(500).json({ success: false, message: "إعدادات الإرسال غير مهيأة (ENV)" });
    }

    const msg = `رمز التحقق الخاص بك في مجمع فينكس الطبي: ${otp}`;
    const url = `https://mywhats.cloud/api/send?number=${phone}&type=text&message=${encodeURIComponent(msg)}&instance_id=${INSTANCE_ID}&access_token=${ACCESS_TOKEN}`;

    await axios.get(url, { timeout: 15000 });
    return res.json({ success: true });
  } catch (err) {
    console.error('/send-otp error:', err?.message || err);
    return res.status(500).json({ success: false, message: "فشل إرسال الرسالة", error: err?.message });
  }
});

// ====== جلب الأوقات ======
app.post('/api/times', async (req, res) => {
  try {
    const { clinic, month } = req.body || {};
    if (!clinic || !month) return res.status(400).json({ times: [], error: 'العيادة أو الشهر مفقود' });

    const times = await getAvailableTimes({ clinic, month });
    res.json({ times });
  } catch (err) {
    console.error("خطأ في /api/times:", err);
    res.json({ times: [], error: err.message || String(err) });
  }
});

async function getAvailableTimes({ clinic, month }) {
  const browser = await puppeteer.launch(getLaunchOptions());
  const page = await browser.newPage();
  await prepPage(page);

  try {
    await page.goto('https://phoenix.imdad.cloud/medica13/login.php?a=1', { waitUntil: 'networkidle2' });
    await page.$eval('input[name="username"]', el => { el.value = '1111111111'; });
    await page.$eval('input[name="password"]', el => { el.value = '1111111111'; });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.click('#submit')
    ]);

    await page.goto('https://phoenix.imdad.cloud/medica13/appoint_display.php', { waitUntil: 'networkidle2' });

    const clinicValue = await page.evaluate((name) => {
      const options = Array.from(document.querySelectorAll('#clinic_id option'));
      const found = options.find(opt => opt.textContent.trim() === name);
      return found ? found.value : null;
    }, clinic);
    if (!clinicValue) throw new Error('لم يتم العثور على العيادة!');

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.select('#clinic_id', clinicValue)
    ]);

    const months = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#month1 option')).map(opt => ({ value: opt.value, text: opt.textContent }))
    );
    const monthValue = months.find(m => m.text === month || m.value === month)?.value;
    if (!monthValue) throw new Error('لم يتم العثور على الشهر المطلوب!');

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.select('#month1', monthValue)
    ]);

    const times = await page.evaluate(() => {
      function period24(timeStr) {
        if (!timeStr) return '';
        const h = parseInt(timeStr.split(':')[0], 10);
        return h < 12 ? 'ص' : 'م';
      }
      const result = [];
      const radios = document.querySelectorAll('input[type="radio"][name="ss"]:not(:disabled)');
      for (const radio of radios) {
        const value = radio.value || "";
        const parts = value.split('*');
        const date = parts[0];
        const time24 = parts[1];
        const label = time24 ? `${date} - ${time24} ${period24(time24)}` : `${date}`;
        result.push({ label, value });
      }
      return result;
    });

    await browser.close();
    return times;
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// ====== الحجز (مع طابور) ======
app.post('/api/book', async (req, res) => {
  bookingQueue.push({ req, res });
  processBookingQueue();
});

let processingBooking = false;
async function processBookingQueue() {
  if (processingBooking || bookingQueue.length === 0) return;
  processingBooking = true;

  const { req, res } = bookingQueue.shift();
  let account = null;

  try {
    account = await acquireAccount();
    const result = await bookAppointment({ ...req.body, account });
    res.json({ msg: result });
  } catch (err) {
    res.json({ msg: '❌ فشل الحجز! ' + (err?.message || String(err)) });
  } finally {
    if (account) releaseAccount(account);
    processingBooking = false;
    processBookingQueue();
  }
}

async function bookAppointment({ name, phone, clinic, month, time, account }) {
  const browser = await puppeteer.launch(getLaunchOptions());
  const page = await browser.newPage();
  await prepPage(page);

  try {
    await page.goto('https://phoenix.imdad.cloud/medica13/login.php?a=1', { waitUntil: 'networkidle2' });
    await page.$eval('input[name="username"]', (el, value) => { el.value = value; }, account.user);
    await page.$eval('input[name="password"]', (el, value) => { el.value = value; }, account.pass);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.click('#submit')
    ]);

    await page.goto('https://phoenix.imdad.cloud/medica13/appoint_display.php', { waitUntil: 'networkidle2' });

    const clinicValue = await page.evaluate((name) => {
      const options = Array.from(document.querySelectorAll('#clinic_id option'));
      const found = options.find(opt => opt.textContent.trim() === name);
      return found ? found.value : null;
    }, clinic);
    if (!clinicValue) throw new Error('لم يتم العثور على العيادة!');

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.select('#clinic_id', clinicValue)
    ]);

    const months = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#month1 option')).map(opt => ({ value: opt.value, text: opt.textContent }))
    );
    const monthValue = months.find(m => m.text === month || m.value === month)?.value;
    if (!monthValue) throw new Error('لم يتم العثور على الشهر المطلوب!');

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.select('#month1', monthValue)
    ]);

    await page.$eval('#SearchBox120', (el, v) => { el.value = v; }, name);
    await page.$eval('input[name="phone"]', (el, v) => { el.value = v; }, phone);
    await page.$eval('input[name="notes"]', (el, v) => { el.value = v; }, 'حجز أوتوماتيكي');
    await page.select('select[name="gender"]', '1');
    await page.select('select[name="nation_id"]', '1');

    const found = await page.evaluate((wantedValue) => {
      const radios = document.querySelectorAll('input[type="radio"][name="ss"]');
      for (const radio of radios) {
        if (radio.value === wantedValue && !radio.disabled) {
          radio.click();
          return true;
        }
      }
      return false;
    }, time);
    if (!found) throw new Error('لم يتم العثور على الموعد المطلوب!');

    const btnResult = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('input[type="submit"][name="submit"]')).find(
        el => el.value && el.value.trim() === "حجز : Reserve"
      );
      if (btn) {
        btn.disabled = false;
        btn.removeAttribute('disabled');
        btn.focus();
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        btn.click();
        btn.form && btn.form.dispatchEvent(new Event('submit', { bubbles: true }));
        return true;
      }
      return false;
    });

    if (!btnResult) throw new Error("لم يتم العثور على زر الحجز أو لم يُضغط!");

    await page.waitForSelector('#popupContact', { visible: true, timeout: 15000 });

    const popupVisible = await page.$eval('#popupContact', el => el.style.display !== 'none');
    if (!popupVisible) throw new Error('لم تظهر نافذة تأكيد الحجز!');

    await browser.close();
    return "✅ تم الحجز بنجاح بالحساب: " + account.user;
  } catch (err) {
    await browser.close();
    return "❌ فشل الحجز: " + (err?.message || "حدث خطأ غير متوقع");
  }
}

// ====== تحقق رمز OTP ======
app.post('/verify-otp', async (req, res) => {
  let { phone, otp } = req.body || {};
  phone = normalizePhone(phone);

  if (otpStore[phone] && otpStore[phone].toString() === String(otp)) {
    delete otpStore[phone];
    res.json({ success: true });
  } else {
    res.json({ success: false, message: "رمز التحقق غير صحيح!" });
  }
});

// ====== Healthcheck ======
app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ====== تشغيل السيرفر ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
