const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

app.post('/api/times', async (req, res) => {
  console.log('تم استقبال طلب أوقات:', req.body);
  try {
    const times = await getAvailableTimes(req.body);
    console.log('تم جلب الأوقات بنجاح:', times.length, 'موعد');
    res.json({ times });
  } catch (err) {
    console.error('خطأ في api/times:', err);
    res.json({ times: [] });
  }
});

async function getAvailableTimes({ clinic, month }) {
  console.log('جلب أوقات للعيادة والشهر:', { clinic, month });

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-networking',
      '--window-size=1200,900',
      '--window-position=0,0'
    ],
    executablePath: process.env.CHROME_BIN || undefined
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });

  let times = [];
  try {
    await page.goto('https://phoenix.imdad.cloud/medica13/login.php?a=1', { waitUntil: 'networkidle2' });
    console.log('تم الدخول لصفحة تسجيل الدخول');

    await page.$eval('input[name="username"]', (el) => el.value = '');
    await page.$eval('input[name="password"]', (el) => el.value = '');
    await page.$eval('input[name="username"]', (el) => el.value = '1111111111');
    await page.$eval('input[name="password"]', (el) => el.value = '1111111111');

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.click('#submit')
    ]);
    console.log('تم تسجيل الدخول');

    await page.goto('https://phoenix.imdad.cloud/medica13/appoint_display.php', { waitUntil: 'networkidle2' });
    console.log('تم الدخول لصفحة عرض المواعيد');

    const clinicValue = await page.evaluate((clinicName) => {
      const options = Array.from(document.querySelectorAll('#clinic_id option'));
      console.log('خيارات العيادة:', options.map(o => o.textContent.trim()));
      const found = options.find(opt => opt.textContent.trim() === clinicName);
      return found ? found.value : null;
    }, clinic);

    console.log('قيمة العيادة المختارة:', clinicValue);
    if (!clinicValue) throw new Error('لم يتم العثور على العيادة!');

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.select('#clinic_id', clinicValue)
    ]);
    console.log('تم اختيار العيادة');

    const months = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('#month1 option')).map(opt => ({ value: opt.value, text: opt.textContent }));
    });
    console.log('خيارات الأشهر:', months);

    const monthValue = months.find(m => m.text === month || m.value === month)?.value;
    console.log('قيمة الشهر المختارة:', monthValue);
    if (!monthValue) throw new Error('لم يتم العثور على الشهر المطلوب!');

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.select('#month1', monthValue)
    ]);
    console.log('تم اختيار الشهر');

    times = await page.evaluate(() => {
      function period24(timeStr) {
        if (!timeStr) return '';
        let h = parseInt(timeStr.split(':')[0], 10);
        return h < 12 ? 'ص' : 'م';
      }
      const result = [];
      const radios = document.querySelectorAll('input[type="radio"][name="ss"]:not(:disabled)');
      for (let radio of radios) {
        const value = radio.value || "";
        const parts = value.split('*');
        const date = parts[0];
        const time24 = parts[1];
        const label = (time24)
          ? `${date} - ${time24} ${period24(time24)}`
          : `${date}`;
        result.push({ label, value });
      }
      return result;
    });

    console.log('تم جلب الأوقات:', times);

    await browser.close();
    return times;

  } catch (err) {
    console.error('خطأ أثناء جلب الأوقات:', err);
    await browser.close();
    throw err;
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
