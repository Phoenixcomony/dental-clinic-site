const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const twilio = require('twilio');

const app = express();
const PORT = 3000;

// إعداد Twilio
const accountSid = 'AC687723b8638a8a8a98ae180bef0deb56c6';
const authToken = 'f69edd1fe8d73e0f6454515062413f8d';
const twilioPhone = '+19595005378';

const client = twilio(accountSid, authToken);

// لتخزين رموز OTP مؤقتًا
const otpStore = {};

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// إرسال رمز OTP
app.post('/send-otp', async (req, res) => {
  const { name, phone, service, date } = req.body;

  if (!phone || !name || !service || !date) {
    return res.status(400).json({ success: false, message: 'جميع الحقول مطلوبة' });
  }

  const otp = Math.floor(100000 + Math.random() * 900000); // توليد رمز مكون من 6 أرقام
  otpStore[phone] = { otp, name, service, date };

  try {
    await client.messages.create({
      body: `رمز التحقق الخاص بك من مجمع فينكس الطبي هو: ${otp}`,
      from: twilioPhone,
      to: phone.startsWith('+') ? phone : `+966${phone.replace(/^0/, '')}`
    });

    console.log(`✅ تم إرسال OTP ${otp} إلى ${phone}`);
    res.json({ success: true, message: 'تم إرسال رمز التحقق' });
  } catch (error) {
    console.error('❌ خطأ في إرسال الرسالة:', error); // ← طباعة الخطأ بالتفصيل
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء إرسال الرمز', error: error.message });
  }
});

// التحقق من رمز OTP
app.post('/verify-otp', (req, res) => {
  const { phone, otp } = req.body;

  const record = otpStore[phone];
  if (!record) {
    return res.status(400).json({ success: false, message: 'رقم غير معروف أو لم يتم إرسال رمز له' });
  }

  if (record.otp == otp) {
    const message = `✅ تم تأكيد الحجز لـ ${record.name}\nالخدمة: ${record.service}\nالتاريخ: ${record.date}`;

    client.messages.create({
      body: message,
      from: twilioPhone,
      to: phone.startsWith('+') ? phone : `+966${phone.replace(/^0/, '')}`
    }).then(() => {
      console.log(`📩 تم إرسال تأكيد الحجز إلى ${phone}`);
    });

    delete otpStore[phone]; // حذف الرمز بعد التحقق

    res.json({ success: true, message: '✅ تم التحقق من الرمز وتأكيد الحجز' });
  } else {
    res.status(401).json({ success: false, message: '❌ رمز غير صحيح' });
  }
});

// تشغيل الخادم
app.listen(PORT, () => {
  console.log(`✅ الخادم يعمل على http://localhost:${PORT}`);
});
