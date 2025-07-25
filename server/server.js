const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// بيانات mywhats.cloud
const INSTANCE_ID = '660F18AC0A49E';
const ACCESS_TOKEN = '65bbe08452619';

// بيانات Google Sheet
const SPREADSHEET_ID = '1c3XE-74QYs-2qe6U1IwJbdfkHvy5On77NnPkE6eN5tA';
const SHEET_NAME = 'الورقة1'; // اسم الورقة

const otpStore = {}; // تخزين رموز OTP مؤقتًا

// ------------ Google Auth (من متغير البيئة) ----------------------
let credentials;
try {
  credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  console.log('✔️ تم تحميل Google Credentials من متغير البيئة.');
} catch (err) {
  console.error('❌ لم يتم العثور على متغير البيئة GOOGLE_CREDENTIALS أو فيه خطأ في التنسيق.');
}
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets('v4');
// -------------------------------------------------------------------

// Endpoint جديد يجلب المواعيد مباشر من الشيت بدون كاش ولا تأخير
app.get('/slots', async (req, res) => {
  try {
    const client = await auth.getClient();
    const getRows = await sheets.spreadsheets.values.get({
      auth: client,
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1:Z`,
    });
    res.json({ rows: getRows.data.values });
  } catch (err) {
    console.error("❌ خطأ في جلب المواعيد من الشيت:", err);
    res.status(500).json({ error: err.message });
  }
});

// إرسال OTP عبر واتساب
app.post('/send-otp', async (req, res) => {
  const { phone } = req.body;
  const otp = Math.floor(100000 + Math.random() * 900000);
  otpStore[phone] = otp;
  console.log("طلب إرسال OTP على الرقم:", phone, "| الرمز:", otp);

  const msg = `رمز التحقق الخاص بك في مجمع فينكس الطبي: ${otp}`;
  const url = `https://mywhats.cloud/api/send?number=${phone}&type=text&message=${encodeURIComponent(msg)}&instance_id=${INSTANCE_ID}&access_token=${ACCESS_TOKEN}`;
  try {
    await axios.get(url);
    console.log("تم إرسال الطلب إلى mywhats.cloud بنجاح!");
    res.json({ success: true });
  } catch (err) {
    console.error("فشل إرسال الرسالة:", err.message);
    res.status(500).json({ success: false, message: "فشل إرسال الرسالة", error: err.message });
  }
});

// تحديث بيانات الحجز في Google Sheet
async function updateSheet({ service, serviceType, date, time, name, phone }) {
  console.log("🟡 بدأ تحديث الشيت...");
  let client;
  try {
    client = await auth.getClient();
    console.log("🟢 تم الحصول على العميل بنجاح");
  } catch (err) {
    console.error("🔴 فشل الحصول على Google API Client:", err);
    throw err;
  }

  // جلب كل الصفوف
  let rows;
  try {
    const getRows = await sheets.spreadsheets.values.get({
      auth: client,
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1:Z`,
    });
    rows = getRows.data.values;
    if (!rows || rows.length === 0) throw new Error("الجدول فارغ");
  } catch (err) {
    console.error("🔴 فشل جلب الصفوف من الشيت:", err);
    throw err;
  }

  // الأعمدة: الخدمة | نوع الخدمة | التاريخ | الوقت | الحالة | الاسم | رقم
  const idx = {
    service: 0,
    serviceType: 1,
    date: 2,
    time: 3,
    status: 4,
    name: 5,
    phone: 6,
  };

  let rowIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (
      row[idx.service] === service &&
      row[idx.serviceType] === serviceType &&
      row[idx.date] === date &&
      row[idx.time] === time
    ) {
      rowIndex = i + 1; // تبدأ الصفوف من 1 وليس من 0
      break;
    }
  }

  if (rowIndex > 0) {
    // تحديث الحقول المطلوبة فقط
    const newRow = [
      service,
      serviceType,
      date,
      time,
      "محجوز",
      name,
      phone
    ];
    try {
      await sheets.spreadsheets.values.update({
        auth: client,
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A${rowIndex}:G${rowIndex}`,
        valueInputOption: "USER_ENTERED",
        resource: { values: [newRow] },
      });
      console.log("✅ تم تحديث الحجز في الشيت بنجاح");
    } catch (err) {
      console.error("🔴 خطأ أثناء تحديث الشيت:", err);
      throw err;
    }
  } else {
    throw new Error("لم يتم العثور على الصف لتحديثه");
  }
}

// التحقق من الكود وإرسال رسالة تأكيد الحجز
app.post('/verify-otp', async (req, res) => {
  console.log('Received data:', req.body);

  const { phone, otp, name, service, serviceType, date, time } = req.body;
  if (otpStore[phone] && otpStore[phone].toString() === otp.toString()) {
    delete otpStore[phone];

    // رسالة التأكيد
    const confirmMsg = `تم تأكيد حجزك في مجمع فينكس الطبي ✅\nالاسم: ${name}\nالخدمة: ${service}\nنوع الخدمة: ${serviceType}\nالتاريخ: ${date}\nالوقت: ${time}`;
    const confirmUrl = `https://mywhats.cloud/api/send?number=${phone}&type=text&message=${encodeURIComponent(confirmMsg)}&instance_id=${INSTANCE_ID}&access_token=${ACCESS_TOKEN}`;

    try {
      await axios.get(confirmUrl);
      await updateSheet({ service, serviceType, date, time, name, phone });
      res.json({ success: true });
    } catch (err) {
      console.error("خطأ أثناء إرسال رسالة التأكيد أو تحديث الشيت:", err);
      res.status(500).json({ success: false, message: "فشل إرسال رسالة التأكيد أو تحديث الشيت", error: err.message });
    }
  } else {
    res.json({ success: false, message: "رمز التحقق غير صحيح!" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
