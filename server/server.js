const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

// بيانات واتساب mywhats.cloud
const INSTANCE_ID = '660F18AC0A49E';
const ACCESS_TOKEN = '65bbe08452619';

// الحسابات الأربعة
const ACCOUNTS = [
  { user: "1111111111", pass: "1111111111", busy: false },
  { user: "2222222222", pass: "2222222222", busy: false },
  { user: "3333333333", pass: "3333333333", busy: false },
  { user: "5555555555", pass: "5555555555", busy: false }
];

// Queue للحجوزات إذا كل الحسابات مشغولة
const bookingQueue = [];

// دالة لتصحيح الجوال
function normalizePhone(phone) {
  phone = (phone || '').replace(/[^0-9]/g, '');
  if (phone.startsWith('05') && phone.length === 10) {
    return '966' + phone.slice(1);
  }
  if (phone.startsWith('5') && phone.length === 9) {
    return '966' + phone;
  }
  if (phone.startsWith('9665') && phone.length === 12) {
    return phone;
  }
  return phone;
}

// --------------- إرسال رمز التحقق عبر واتساب ------------------
const otpStore = {};

app.post('/send-otp', async (req, res) => {
  let { phone } = req.body;
  phone = normalizePhone(phone);

  if (!/^9665\d{8}$/.test(phone)) {
    return res.status(400).json({ success: false, message: "رقم الجوال غير صحيح" });
  }

  const otp = Math.floor(100000 + Math.random() * 900000);
  otpStore[phone] = otp;
  console.log("طلب إرسال OTP على الرقم:", phone, "| الرمز:", otp);

  const msg = `رمز التحقق الخاص بك في مجمع فينكس الطبي: ${otp}`;
  const url = `https://mywhats.cloud/api/send?number=${phone}&type=text&message=${encodeURIComponent(msg)}&instance_id=${INSTANCE_ID}&access_token=${ACCESS_TOKEN}`;
  try {
    await axios.get(url);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: "فشل إرسال الرسالة", error: err.message });
  }
});

// ------------- نظام إدارة الحسابات --------------

// حجز حساب غير مشغول، أو الانتظار حتى يتوفر واحد
async function acquireAccount() {
  while (true) {
    const idx = ACCOUNTS.findIndex(acc => !acc.busy);
    if (idx !== -1) {
      ACCOUNTS[idx].busy = true;
      return ACCOUNTS[idx];
    }
    // لو كل الحسابات مشغولة انتظر 1 ثانية وجرب من جديد
    await new Promise(res => setTimeout(res, 1000));
  }
}
// تحرير الحساب بعد انتهاء الحجز
function releaseAccount(account) {
  const idx = ACCOUNTS.findIndex(acc => acc.user === account.user);
  if (idx !== -1) ACCOUNTS[idx].busy = false;
}

// ----------- جلب الأوقات من البوت (Puppeteer) -----------
app.post('/api/times', async (req, res) => {
  try {
    const times = await getAvailableTimes(req.body);
    res.json({ times });
  } catch (err) {
    res.json({ times: [] });
  }
});

async function getAvailableTimes({ clinic, month }) {
  const browser = await puppeteer.launch({
    headless: "new",
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
    ],
    executablePath: process.env.CHROME_BIN || undefined  // المهم للتشغيل على سيرفرات كـ Render
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  let times = [];
  try {
    await page.goto('https://phoenix.imdad.cloud/medica13/login.php?a=1', { waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      document.querySelector('input[name="username"]').value = '';
      document.querySelector('input[name="password"]').value = '';
    });
    await page.$eval('input[name="username"]', (el) => el.value = '1111111111');
    await page.$eval('input[name="password"]', (el) => el.value = '1111111111');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.click('#submit')
    ]);
    await page.goto('https://phoenix.imdad.cloud/medica13/appoint_display.php', { waitUntil: 'networkidle2' });

    // اختيار العيادة
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

    // اختيار الشهر
    const months = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('#month1 option')).map(opt => ({ value: opt.value, text: opt.textContent }));
    });
    const monthValue = months.find(m => m.text === month || m.value === month)?.value;
    if (!monthValue) throw new Error('لم يتم العثور على الشهر المطلوب!');

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.select('#month1', monthValue)
    ]);

    // جلب الأوقات
    times = await page.evaluate(() => {
      function period24(timeStr) {
        if (!timeStr) return '';
        let h = parseInt(timeStr.split(':')[0], 10);
        return h < 12 ? 'ص' : 'م';
      }
      const result = [];
      const radios = document.querySelectorAll('input[type="radio"][name="ss"]:not(:disabled)');
      for (let radio of radios) {
        const value = radio.value || "";
        const parts = value.split('*');
        const date = parts[0];
        const time24 = parts[1];
        const label = (time24)
          ? `${date} - ${time24} ${period24(time24)}`
          : `${date}`;
        result.push({
          label,
          value
        });
      }
      return result;
    });

    await browser.close();
    return times;
  } catch (err) {
    await browser.close();
    return [];
  }
}

// --------------- تنفيذ الحجز مع اختيار حساب غير مشغول ------------------
app.post('/api/book', async (req, res) => {
  // أضف كل طلب إلى الدور (Queue)
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
    // حجز حساب متاح (أو الانتظار حتى يتوفر)
    account = await acquireAccount();
    const result = await bookAppointment({ ...req.body, account });
    res.json({ msg: result });
  } catch (err) {
    res.json({ msg: '❌ فشل الحجز! ' + err.message });
  } finally {
    if (account) releaseAccount(account);
    processingBooking = false;
    // بعد الانتهاء من هذا الحجز، نفذ الحجز التالي في الدور
    processBookingQueue();
  }
}

async function bookAppointment({ name, phone, clinic, month, time, account }) {
  const browser = await puppeteer.launch({
    headless: "new",
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
    ],
    executablePath: process.env.CHROME_BIN || undefined // مهم جداً على Render
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  try {
    await page.goto('https://phoenix.imdad.cloud/medica13/login.php?a=1', { waitUntil: 'networkidle2' });
    await page.$eval('input[name="username"]', (el) => el.value = '');
    await page.$eval('input[name="password"]', (el) => el.value = '');
    await page.$eval('input[name="username"]', (el, value) => el.value = value, account.user);
    await page.$eval('input[name="password"]', (el, value) => el.value = value, account.pass);

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
    const months = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('#month1 option')).map(opt => ({ value: opt.value, text: opt.textContent }));
    });
    const monthValue = months.find(m => m.text === month || m.value === month)?.value;
    if (!monthValue) throw new Error('لم يتم العثور على الشهر المطلوب!');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.select('#month1', monthValue)
    ]);

    await page.$eval('#SearchBox120', (el, v) => el.value = v, name);
    await page.$eval('input[name="phone"]', (el, v) => el.value = v, phone);
    await page.$eval('input[name="notes"]', (el, v) => el.value = v, 'حجز أوتوماتيكي');
    await page.select('select[name="gender"]', '1');
    await page.select('select[name="nation_id"]', '1');

    const found = await page.evaluate((wantedValue) => {
      const radios = document.querySelectorAll('input[type="radio"][name="ss"]');
      for (let radio of radios) {
        if (radio.value === wantedValue && !radio.disabled) {
          radio.click();
          return true;
        }
      }
      return false;
    }, time);
    if (!found) throw new Error('لم يتم العثور على الموعد المطلوب!');

    // اضغط زر الحجز (بداخل evaluate)
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
    return "❌ فشل الحجز: " + (err.message || "حدث خطأ غير متوقع");
  }
}

// ----------- تحقق رمز OTP (ومن ثم يسمح بالانتقال للنجاح) -------------
app.post('/verify-otp', async (req, res) => {
  let { phone, otp } = req.body;
  phone = normalizePhone(phone);

  if (otpStore[phone] && otpStore[phone].toString() === otp.toString()) {
    delete otpStore[phone];
    res.json({ success: true });
  } else {
    res.json({ success: false, message: "رمز التحقق غير صحيح!" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
