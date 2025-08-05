#!/bin/bash
echo "بدء تثبيت المتطلبات..."

# تثبيت Google Chrome (مسار تنفيذي معروف على Render)
if ! command -v google-chrome >/dev/null 2>&1; then
  echo "Google Chrome غير مثبت. الرجاء تثبيته يدوياً على Render."
else
  echo "Google Chrome مثبت."
fi

# تثبيت الحزم
npm install

echo "اكتمل البناء."
