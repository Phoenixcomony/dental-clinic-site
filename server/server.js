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
const INSTANCE_ID = process.env.INSTANCE_ID || '660F18AC0A49E';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '65bbe08452619';

// الحسابات الأربعة (نماذج لحجز متعدد الحسابات مع حالة مشغول/فارغ)
const ACCOUNTS = [
  { user: "1111111111", pass: "1111111111", busy: false },
  { user: "2222222222", pass: "2222222222", busy: false },
  { user: "3333333333", pass: "3333333333", busy: false },
  { user: "5555555555", pass: "5555555555", busy: false }
];

// قائمة انتظار الحجز عند انشغال كل الحسابات
const bookingQueue = [];

// تخزين رموز التحقق OTP مؤقتاً
const otpStore = {};

// دالة تصحيح رقم الجوال
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

// إرسال رمز التحقق OTP عبر واتساب (mywhats.cloud)
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
    console.error("فشل إرسال OTP عبر واتساب:", err.message);
    res.status(500).json({ success: false, message: "فشل إرسال الرسالة", error: err.message });
  }
});

// إدارة حالة الحسابات (لحجز متعدد مع انتظار إذا كانت جميع الحسابات مشغولة)
async function acquireAccount() {
  while (true) {
    const idx = ACCOUNTS.findIndex(acc => !acc.busy);
    if (idx !== -1) {
      ACCOUNTS[idx].busy = true;
      return ACCOUNTS[idx];
    }
    await new Promise(res => setTimeout(res, 1000)); // انتظار ثانية ثم محاولة مجدداً
  }
}
function releaseAccount(account) {
  const idx = ACCOUNTS.findIndex(acc => acc.user === account.user);
  if (idx !== -1) ACCOUNTS[idx].busy = false;
}

// جلب أوقات الحجز المتاحة عبر Puppeteer
app.post('/api/times', async (req, res) => {
  console.log("تم استقبال طلب أوقات: ", req.body);
  try {
    const times = await getAvailableTimes(req.body);
    console.log("عدد المواعيد المستخرجة:", times.length);
    res.json({ times });
  } catch (err) {
    console.error("خطأ في api/times:", err);
    res.json({ times: [] });
  }
});

async function getAvailableTimes({ clinic, month }) {
  console.log("جلب أوقات للعيادة والشهر:", { clinic, month });
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: '/usr/bin/google-chrome',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1200,900'
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  let times = [];
  try {
    await page.goto('https://phoenix.imdad.cloud/medica13/login.php?a=1', { waitUntil: 'networkidle2' });
    // تسجيل الدخول:
    await page.$eval('input[name="username"]', (el, val) => el.value = val, '1111111111');
    await page.$eval('input[name="password"]', (el, val) => el.value = val, '1111111111');
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

    if (!clinicValue) {
      console.error('لم يتم العثور على العيادة!');
      await browser.close();
      return [];
    }

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.select('#clinic_id', clinicValue)
    ]);

    // اختيار الشهر
    const months = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('#month1 option')).map(opt => ({ value: opt.value, text: opt.textContent }));
    });
    const monthValue = months.find(m => m.text === month || m.value === month)?.value;
    if (!monthValue) {
      console.error('لم يتم العثور على الشهر المطلوب!');
      await browser.close();
      return [];
    }

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.select('#month1', monthValue)
    ]);

    // جلب أوقات الحجز
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
    console.log("تم استخراج المواعيد:", times.length);
    return times;
  } catch (err) {
    console.error("حدث خطأ أثناء جلب الأوقات:", err);
    await browser.close();
    return [];
  }
}

// حجز موعد (منطق الحجز يمكنك تعديله حسب الحاجة)
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
    // هنا يمكنك اضافة منطق الحجز مع Puppeteer أو API الحجز
    res.json({ msg: "تم الحجز بنجاح" });
  } catch (err) {
    console.error("خطأ في الحجز:", err);
    res.json({ msg: '❌ فشل الحجز! ' + err.message });
  } finally {
    if (account) releaseAccount(account);
    processingBooking = false;
    processBookingQueue();
  }
}

// التحقق من رمز OTP
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
