// استيراد مكتبة Vonage
const { Vonage } = require('@vonage/server-sdk');

// تهيئة الاتصال باستخدام بيانات حسابك
const vonage = new Vonage({
  apiKey: "9a46cb44", // 🔑 استبدلها إذا تغيرت
  apiSecret: "OCP6ANU6YJ3dgMce" // 🔐 سرّ الحساب
});

// بيانات الرسالة
const from = "PhoenixMed"; // أو مجمع فينكس بدون رموز عربية (اللغة الإنجليزية أكثر موثوقية)
const to = "966506951322"; // 📱 رقم المستلم بدون +
const text = "مرحبًا! هذه رسالة اختبار من مجمع فينكس الطبي عبر Vonage SMS API";

// الدالة لإرسال الرسالة
async function sendSMS() {
  try {
    const response = await vonage.sms.send({ to, from, text });
    console.log("✅ تم إرسال الرسالة بنجاح!");
    console.dir(response, { depth: null });
  } catch (error) {
    console.error("❌ فشل إرسال الرسالة:");
    console.error(error);
  }
}

// استدعاء الإرسال
sendSMS();
