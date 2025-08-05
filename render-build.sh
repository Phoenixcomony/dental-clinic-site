#!/usr/bin/env bash
set -eux

echo "بدء تثبيت Google Chrome..."

# تثبيت متطلبات النظام
apt-get update
apt-get install -y wget gnupg ca-certificates fonts-liberation

# إضافة مستودع جوجل الرسمي للكروم
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add -
echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list

apt-get update
apt-get install -y google-chrome-stable

echo "تم تثبيت Google Chrome بنجاح"

# يمكنك إضافة أي أوامر أخرى للبناء هنا مثلاً npm run build إذا احتجت

