#!/bin/bash
echo "بدء تثبيت Google Chrome..."

# تحديث المصادر
sudo apt-get update

# تثبيت dependencies المطلوبة
sudo apt-get install -y wget gnupg --no-install-recommends

# تنزيل مفتاح التوقيع الخاص بجوجل كروم
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -

# إضافة مستودع جوجل كروم
echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list

# تحديث المصادر مرة أخرى
sudo apt-get update

# تثبيت Google Chrome (نسخة stable)
sudo apt-get install -y google-chrome-stable

echo "تم تثبيت Google Chrome"
