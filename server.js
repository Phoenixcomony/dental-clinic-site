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
const SHEET_NAME = 'الورقة1'; // اسم الورقة بالضبط

// 1- قراءة google credentials من متغير البيئة
let googleCredentials = null;
try {
  if (process.env.GOOGLE_CREDENTIALS) {
    googleCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    console.log("✔️ تم تحميل Google Credentials من متغير البيئة.");
  } else {
    throw new Error("GOOGLE_CREDENTIALS environment variable not set!");
  }
} catch (err) {
  console.error("❌ خطأ في قراءة google credentials:", err);
}

// 2- إعداد Google Sheets API
const auth = new google.auth.GoogleAuth({
  credentials: googleCredentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets('v4');

const otpStore = {}; // تخزين رموز OTP مؤقتًا

// إرسال رمز التحقق عبر واتساب
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
  console.log("بدأ تحديث الشيت...");
  let client;
  try {
    client = await auth.getClient();
    console.log("تم الحصول على العميل بنجاح");
  } catch (err) {
    console.error("فشل الحصول على Google API Client:", err);
    throw err;
  }

  let getRows;
  try {
    getRows = await sheets.spreadsheets.values.get({
      auth: client,
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1:Z`,
    });
    console.log("تم جلب الصفوف من الشيت");
  } catch (err) {
    console.error("فشل جلب الصفوف من الشيت:", err);
    throw err;
  }

  const rows = getRows.data.values;
  if (!rows || rows.length === 0) {
    console.error("لا يوجد بيانات في الشيت");
    throw new Error("لا يوجد بيانات في الشيت");
  }

  const idx = {
    service: 0,
    serviceType: 1,
    date: 2,
    time: 3,
    status: 4,
    name: 5,
    phone: 6, // عمود رقم
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
      rowIndex = i + 1;
      break;
    }
  }
  if (rowIndex > 0) {
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
      console.log("تم تحديث الحجز في الشيت بنجاح");
    } catch (err) {
      console.error("فشل تحديث بيانات الشيت:", err);
      throw err;
    }
  } else {
    console.log("لم يتم العثور على الصف لتحديثه");
    throw new Error("لم يتم العثور على الصف لتحديثه");
  }
}

// التحقق من الكود وإرسال رسالة تأكيد الحجز
app.post('/verify-otp', async (req, res) => {
  console.log('Received data:', req.body);

  const { phone, otp, name, service, serviceType, date, time } = req.body;
  if (otpStore[phone] && otpStore[phone].toString() === otp.toString()) {
    delete otpStore[phone];

    // رسالة تأكيد الحجز
    const confirmMsg = `تم تأكيد حجزك في مجمع فينكس الطبي ✅\nالاسم: ${name}\nالخدمة: ${service}\nنوع الخدمة: ${serviceType}\nالتاريخ: ${date}\nالوقت: ${time}`;
    const confirmUrl = `https://mywhats.cloud/api/send?number=${phone}&type=text&message=${encodeURIComponent(confirmMsg)}&instance_id=${INSTANCE_ID}&access_token=${ACCESS_TOKEN}`;

    try {
      await axios.get(confirmUrl);
      // تحديث بيانات الشيت بعد نجاح الحجز
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

// استمع على كل الشبكات (مهم لـ Render)
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
