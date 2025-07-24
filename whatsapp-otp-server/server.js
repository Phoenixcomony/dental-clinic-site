// server.js

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// بيانات جهاز مجمع فينكس من mywhats.cloud
const INSTANCE_ID = '660F18AC0A49E';
const ACCESS_TOKEN = '65bbe08452619';

let otpStore = {}; // تخزين رموز OTP مؤقتًا

// إرسال رمز التحقق عبر واتساب
app.post('/send-otp', async (req, res) => {
  const { phone } = req.body; // الرقم بصيغة 9665XXXXXXXX

  // توليد رمز تحقق عشوائي 6 أرقام
  const otp = Math.floor(100000 + Math.random() * 900000);

  // تخزين الرمز مؤقتًا لهذا الرقم
  otpStore[phone] = otp;

  // طباعة الرقم والرمز في الطرفية لمتابعة كل طلب
  console.log("طلب إرسال OTP على الرقم:", phone, "| الرمز:", otp);

  // نص الرسالة
  const msg = `Test OTP: ${otp}`;

  // بناء رابط API ديناميكي
  const url = `https://mywhats.cloud/api/send?number=${phone}&type=text&message=${encodeURIComponent(msg)}&instance_id=${INSTANCE_ID}&access_token=${ACCESS_TOKEN}`;

  try {
    await axios.post(url); // إرسال الرسالة فعليًا
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: "فشل إرسال الرسالة", error: err.message });
  }
});

// التحقق من الكود وإرسال رسالة تأكيد الحجز
app.post('/verify-otp', async (req, res) => {
  const { phone, otp, name, service, date, time } = req.body;
  if (otpStore[phone] && otpStore[phone].toString() === otp.toString()) {
    delete otpStore[phone];

    // رسالة تأكيد الحجز
    const confirmMsg = `Booking confirmed at Phoenix Clinic.\nName: ${name}\nService: ${service}\nDate: ${date}\nTime: ${time}`;

    const confirmUrl = `https://mywhats.cloud/api/send?number=${phone}&type=text&message=${encodeURIComponent(confirmMsg)}&instance_id=${INSTANCE_ID}&access_token=${ACCESS_TOKEN}`;

    try {
      await axios.post(confirmUrl);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, message: "فشل إرسال رسالة التأكيد", error: err.message });
    }
  } else {
    res.json({ success: false, message: "رمز التحقق غير صحيح!" });
  }
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
