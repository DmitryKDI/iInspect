#!/bin/sh
# Внешний контур работает только по HTTPS (TLS 1.3). Сертификат обязателен.
set -eu
if [ -s /etc/nginx/certs/server.crt ] && [ -s /etc/nginx/certs/server.key ]; then
    cp /opt/nginx-tls.conf /etc/nginx/conf.d/tls.conf
    echo "40-tls.sh: HTTPS (TLS 1.3) включён на порту 5443"
else
    echo "40-tls.sh: обязательный TLS-сертификат не найден в /etc/nginx/certs" >&2
    exit 1
fi
