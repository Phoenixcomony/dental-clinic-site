// تأكد من تنصيب puppeteer: npm i puppeteer
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/imdad-book', async (req, res) => {
  const { name, phone, clinic, month, time } = req.body;

  try {
    const browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();

    // 1. الدخول وتسجيل الدخول
    await page.goto('https://phoenix.imdad.cloud/medica13/login.php?a=1', { waitUntil: 'networkidle2' });
    await page.type('#username', '1111111111');
    await page.type('#password', '1111111111');
    await page.click('#submit');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // 2. الذهاب لصفحة العيادة المناسبة
    await page.goto(`https://phoenix.imdad.cloud/medica13/appoint_display.php?clinic_id=${clinic}&per_id=1&day_no=7&month=${month}&year=2025`, { waitUntil: 'networkidle2' });

    // 3. إدخال بيانات المريض
    await page.type('#SearchBox120', name);
    await page.select('select[name="gender"]', '1');
    await page.select('select[name="nation_id"]', '1');
    await page.type('input[name="phone"]', phone);
    await page.type('input[name="notes"]', 'حجز آلي من الموقع');
    await new Promise(r => setTimeout(r, 1000));

    // 4. اختيار الوقت (مثال سريع؛ يمكن تطويره حسب الصفحة)
    await page.evaluate((time) => {
      const cells = Array.from(document.querySelectorAll('td, div')).filter(el => el.textContent.trim() === time);
      if (cells.length > 0) cells[0].click();
    }, time);

    await new Promise(r => setTimeout(r, 1000));

    // 5. الضغط على زر الحجز
    await page.click('input[type="submit"][value*="حجز"]');
    await new Promise(r => setTimeout(r, 2000));

    // (اختياري) أخذ لقطة شاشة
    await page.screenshot({ path: 'imdad-book.png' });

    await browser.close();
    // الرد برسالة نجاح
    res.json({ ok: true, msg: `✅ تم الحجز في نظام إمداد (${name}, ${phone}, ${clinic}, ${month}, ${time})` });
  } catch (e) {
    res.json({ ok: false, msg: '❌ حدث خطأ في عملية الحجز!', error: e.message });
  }
});

app.listen(3000, () => {
  console.log('API Server running on http://localhost:3000');
});
