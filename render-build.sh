#!/bin/bash
echo "بدء تثبيت Google Chrome..."

# تحديث الحزم (بدون sudo)
apt-get update -y || echo "تحديث الحزم غير ممكن بدون صلاحيات"

# تثبيت الحزم اللازمة (بدون sudo)
apt-get install -y wget gnupg || echo "تثبيت الحزم غير ممكن بدون صلاحيات"

# تحميل حزمة Google Chrome (الإصدار المستقر)
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb

# تثبيت الحزمة
dpkg -i google-chrome-stable_current_amd64.deb || apt-get -f install -y || echo "تثبيت Chrome قد فشل، حاول يدوياً"

echo "تم تثبيت Google Chrome"
