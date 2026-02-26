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

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:5000/api/version')" || exit 1

# تهيئة قاعدة البيانات ثم تشغيل الخادم
CMD ["sh", "-c", "python setup_database.py && gunicorn --bind 0.0.0.0:5000 --workers 2 --timeout 120 server:app"]
