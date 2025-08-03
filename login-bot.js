const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: false, defaultViewport: null });
  const page = await browser.newPage();

  // تسجيل الدخول
  await page.goto('https://phoenix.imdad.cloud/medica13/login.php?a=1', { waitUntil: 'networkidle2' });
  await page.type('input[name="username"]', '1111111111');
  await page.type('input[name="password"]', '1111111111');
  await page.click('#submit');
  await new Promise(resolve => setTimeout(resolve, 4000));

  // الذهاب إلى صفحة المواعيد
  await page.goto('https://phoenix.imdad.cloud/medica13/appoint_display.php', { waitUntil: 'networkidle2' });
  await new Promise(resolve => setTimeout(resolve, 2000));

  // اختيار العيادة بالاسم
  const clinicName = "عيادة اسنان 5**الفترة الاولى";
  const clinicValue = await page.evaluate((name) => {
    const options = Array.from(document.querySelectorAll('#clinic_id option'));
    const found = options.find(opt => opt.textContent.trim() === name);
    return found ? found.value : null;
  }, clinicName);

  if (clinicValue) {
    await page.select('#clinic_id', clinicValue);
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    await new Promise(resolve => setTimeout(resolve, 4000));

    // اختيار شهر 8
    const months = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('#month1 option')).map(opt => ({value: opt.value, text: opt.textContent}));
    });
    const monthValue = months.find(m => m.text === '8').value;
    await page.select('#month1', monthValue);
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    await new Promise(resolve => setTimeout(resolve, 2000));

    // تعبئة بيانات المريض
    await page.type('#SearchBox120', 'عبد الرحمن خالد الدوسري*12090*0506951322');
    await page.type('input[name="phone"]', '0506951322');
    await page.type('input[name="notes"]', 'حجز أوتوماتيكي');
    await page.select('select[name="gender"]', '1');
    await page.select('select[name="nation_id"]', '1');
    await new Promise(resolve => setTimeout(resolve, 1000));

    // اختيار موعد محدد (مثلاً 1:00ص)
    const wantedTime = "1:00ص";
    const foundTime = await page.evaluate((wantedTime) => {
      const radios = document.querySelectorAll('input[type="radio"][name="ss"]');
      for (let radio of radios) {
        const label = radio.closest('label');
        if (label) {
          const span = label.querySelector('.front-end.box span');
          if (span && span.textContent.trim() === wantedTime) {
            radio.click();
            return radio.value;
          }
        }
      }
      return null;
    }, wantedTime);

    if (foundTime) {
      console.log('تم اختيار الموعد المطلوب:', wantedTime, 'القيمة:', foundTime);
    } else {
      console.log('لم يتم العثور على موعد بالوقت المطلوب:', wantedTime);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));

    // اضغط زر الحجز
    await page.click('input[type="submit"][value*="حجز"]');
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log("تم الضغط على زر الحجز!");

    // يمكنك هنا مراقبة ظهور رسالة نجاح أو التأكيد
    // await browser.close();

  } else {
    console.log('لم يتم العثور على العيادة المطلوبة!');
  }
})();
