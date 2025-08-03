const puppeteer = require('puppeteer');

module.exports = async function({ name, phone, clinic_id, month, time }) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // تسجيل الدخول
    await page.goto('https://phoenix.imdad.cloud/medica13/login.php?a=1', { waitUntil: 'networkidle2' });
    await page.type('#username', '1111111111');
    await page.type('#password', '1111111111');
    await page.click('#submit');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // الذهاب مباشرة إلى صفحة العيادة مع الشهر المختار
    const url = `https://phoenix.imdad.cloud/medica13/appoint_display.php?clinic_id=${clinic_id}&per_id=1&day_no=7&month=${month}&year=2025`;
    await page.goto(url, { waitUntil: 'networkidle2' });

    // تعبئة البيانات
    await page.type('#SearchBox120', name);
    await page.select('select[name="gender"]', '1');
    await page.select('select[name="nation_id"]', '1');
    await page.type('input[name="phone"]', phone);
    await page.type('input[name="notes"]', 'حجز آلي من الموقع');
    await new Promise(r => setTimeout(r, 900));

    // اختيار الوقت
    const found = await page.evaluate((wantedTime) => {
      const cells = Array.from(document.querySelectorAll('td, div')).filter(el => el.textContent.trim() === wantedTime);
      if (cells.length > 0) {
        cells[0].click();
        return true;
      }
      return false;
    }, time);

    if (!found) {
      await browser.close();
      return 'لم يتم العثور على الوقت المطلوب في الجدول!';
    }

    await new Promise(r => setTimeout(r, 900));

    // الضغط على زر الحجز
    await page.click('input[type="submit"][value*="حجز"]');
    await new Promise(r => setTimeout(r, 1300));

    // راقب ظهور رسالة النجاح (عدّل حسب رسالة النظام فعليًا)
    const pageContent = await page.content();
    let resultMsg = "";

    // جرب البحث عن رسالة نجاح أو أي تغير بالصفحة!
    if (pageContent.includes('تم الحجز بنجاح') || pageContent.includes('تمت الإضافة بنجاح') || pageContent.includes('الحجز')) {
      resultMsg = "تم الحجز بنجاح ✅";
    } else if (pageContent.includes('خطأ')) {
      resultMsg = "حدث خطأ أثناء الحجز في إمداد!";
    } else {
      resultMsg = "لم يتم التأكد من الحجز. راجع النظام يدويًا!";
    }

    await browser.close();
    return resultMsg;

  } catch (err) {
    await browser.close();
    return "فشل الحجز: " + (err.message || "حدث خطأ غير متوقع");
  }
};
