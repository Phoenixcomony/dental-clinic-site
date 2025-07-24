// server.js

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// بيانات جهازك في mywhats.cloud (رقم الشركة هنا فقط للإرسال!)
const INSTANCE_ID = '660F18AC0A49E';      // استبدلها بما هو في حسابك
const ACCESS_TOKEN = '65bbe08452619';     // استبدلها بما هو في حسابك

let otpStore = {}; // تخزين رموز OTP مؤقتًا

// إرسال رمز التحقق للعميل
app.post('/send-otp', async (req, res) => {
  const { phone } = req.body; // هنا رقم العميل الذي كتبه بنفسه في الموقع

  const otp = Math.floor(100000 + Math.random() * 900000);
  otpStore[phone] = otp;

  // رسالة اختبارية للتأكد
  const msg = `Test OTP: ${otp}`;

  // سيتم الإرسال من رقم الشركة (555) إلى رقم العميل فقط
  const url = `https://mywhats.cloud/api/send?number=${phone}&type=text&message=${encodeURIComponent(msg)}&instance_id=${INSTANCE_ID}&access_token=${ACCESS_TOKEN}`;

  console.log("طلب إرسال OTP على الرقم:", phone, "| الرمز:", otp);

  try {
    await axios.post(url);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: "فشل إرسال الرسالة", error: err.message });
  }
});

// التحقق من الرمز وإرسال رسالة التأكيد للعميل
app.post('/verify-otp', async (req, res) => {
  const { phone, otp, name, service, date, time } = req.body;
  if (otpStore[phone] && otpStore[phone].toString() === otp.toString()) {
    delete otpStore[phone];

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
