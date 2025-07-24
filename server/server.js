const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const { google } = require('googleapis');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// بيانات جهازك من mywhats.cloud
const INSTANCE_ID = '660F18AC0A49E';
const ACCESS_TOKEN = '65bbe08452619';

// بيانات Google Sheet
const SPREADSHEET_ID = '1c3XE-74QYs-2qe6U1IwJbdfkHvy5On77NnPkE6eN5tA';
const SHEET_NAME = 'الورقة1'; // اسم الورقة بالضبط
const CREDENTIALS_PATH = path.join(__dirname, 'google-credentials.json');

const otpStore = {}; // تخزين رموز OTP مؤقتًا

// إعداد Google Sheets API
const auth = new google.auth.GoogleAuth({
  keyFile: CREDENTIALS_PATH,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets('v4');

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
  const client = await auth.getClient();

  // جلب كل الصفوف
  const getRows = await sheets.spreadsheets.values.get({
    auth: client,
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1:Z`, // غيّر النطاق إذا لديك أعمدة أكثر
  });
  const rows = getRows.data.values;
  if (!rows || rows.length === 0) return;

  // الأعمدة حسب الشيت: الخدمة | نوع الخدمة | التاريخ | الوقت | الحالة | الاسم | رقم
  const idx = {
    service: 0,
    serviceType: 1,
    date: 2,
    time: 3,
    status: 4,
    name: 5,
    phone: 6, // العمود اسمه (رقم)
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
      rowIndex = i + 1; // صفوف جوجل تبدأ من 1
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
    await sheets.spreadsheets.values.update({
      auth: client,
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A${rowIndex}:G${rowIndex}`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [newRow] },
    });
    console.log("تم تحديث الحجز في الشيت بنجاح");
  } else {
    console.log("لم يتم العثور على الصف لتحديثه");
  }
}

// التحقق من الكود وإرسال رسالة تأكيد الحجز
app.post('/verify-otp', async (req, res) => {
  // 👈 هنا نطبع كل ما يصل من الفرونتند
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
      res.status(500).json({ success: false, message: "فشل إرسال رسالة التأكيد أو تحديث الشيت", error: err.message });
    }
  } else {
    res.json({ success: false, message: "رمز التحقق غير صحيح!" });
  }
});

app.listen(3000, '0.0.0.0', () => {
  console.log('Server running...');
});
