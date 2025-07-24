const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const twilio = require('twilio');

// بيانات حسابك من Twilio
const accountSid = 'ضع هنا الـ Account SID من Twilio';
const authToken = 'ضع هنا الـ Auth Token';
const twilioClient = twilio(accountSid, authToken);
const twilioNumber = 'رقمك من Twilio مثل: +1234567890';

const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.json());

// قاعدة بيانات مؤقتة للرموز
const otpStore = {};

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// إرسال رمز التحقق
app.post('/api/send-otp', async (req, res) => {
  const { name, phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'رقم الجوال مطلوب' });

  const otp = generateOTP();
  otpStore[phone] = { otp, name, timestamp: Date.now() };

  try {
    await twilioClient.messages.create({
      body: `رمز التحقق الخاص بك هو: ${otp}`,
      from: twilioNumber,
      to: phone
    });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ خطأ في إرسال الرسالة:', err);
    res.status(500).json({ error: 'فشل في إرسال رمز التحقق' });
  }
});

// التحقق من الرمز
app.post('/api/verify-otp', (req, res) => {
  const { phone, otp } = req.body;
  const record = otpStore[phone];

  if (record && record.otp === otp) {
    res.json({
      success: true,
      message: `✅ تم حجز الموعد بنجاح يا ${record.name}`
    });

    delete otpStore[phone]; // حذف بعد الاستخدام
  } else {
    res.status(401).json({ success: false, message: '❌ رمز التحقق غير صحيح' });
  }
});

app.listen(3000, '0.0.0.0', () => {
  console.log('Server running...');
});
