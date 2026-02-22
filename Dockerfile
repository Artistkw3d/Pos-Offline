# استخدام Python 3.11 slim (خفيف جداً)
FROM python:3.11-slim

# تعيين مجلد العمل
WORKDIR /app

# نسخ ملفات المتطلبات أولاً (للاستفادة من cache)
COPY requirements.txt .

# تنصيب المكتبات المطلوبة
RUN pip install --no-cache-dir -r requirements.txt

# نسخ جميع ملفات التطبيق
COPY server.py .
COPY setup_database.py .
COPY frontend/ ./frontend/
COPY database/ ./database/

# إنشاء مجلد للنسخ الاحتياطية
RUN mkdir -p /app/database/backups

# فتح المنفذ 5000
EXPOSE 5000

# تشغيل الخادم
CMD ["python", "server.py"]
