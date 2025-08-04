#!/bin/bash
echo "بدء البناء..."

# تثبيت جوجل كروم بدون صلاحيات root (بدون sudo)
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
dpkg -x google-chrome-stable_current_amd64.deb chrome

# تعيين مسار كروم ليستخدمه Puppeteer
export CHROME_BIN=$(pwd)/chrome/opt/google/chrome/google-chrome

# تثبيت الحزم npm (تأكد أنك في مجلد المشروع)
npm install

echo "اكتمل البناء."
