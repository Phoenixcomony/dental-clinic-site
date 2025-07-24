const Airtable = require('airtable');

const base = new Airtable({ apiKey: 'patF0RIN2ytlgNekb.b75b1dc0131c2f3ab7b9dae516e0466d7affdd724214b31fe7ab7ddab085497e' }).base('appbFHikZeqIPygzW');

base('الحجوزات').select({ maxRecords: 3 }).eachPage(
  function page(records, fetchNextPage) {
    records.forEach(function(record) {
      console.log('📄 سجل:', record.fields);
    });
    fetchNextPage();
  },
  function done(err) {
    if (err) {
      console.error('❌ خطأ في جلب البيانات:', err);
      return;
    }
    console.log('✅ تم الانتهاء من جلب السجلات بنجاح');
  }
);


