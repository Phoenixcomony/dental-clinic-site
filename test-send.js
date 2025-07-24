const axios = require('axios');

// غيّر الرقم لرقمك الصحيح
const url = 'https://mywhats.cloud/api/send?number=9665XXXXXXXX&type=text&message=اختبار&instance_id=660F18AC0A49E&access_token=65bbe08452619';

// جرب GET
axios.get(url)
  .then(r => console.log('GET:', r.data))
  .catch(e => console.log('GET ERROR:', e.response?.data || e.message));

// جرب POST
axios.post(url)
  .then(r => console.log('POST:', r.data))
  .catch(e => console.log('POST ERROR:', e.response?.data || e.message));
