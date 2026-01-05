# Opal ZiVPN Bot (Auto 24 Jam)

Bot Telegram untuk jual/buat akun ZiVPN otomatis:
- Pilih server (IP limit 1/2) + status penuh/tersedia
- Create akun: Domain / Password / Expired
- MODE=PAID: TopUp Pakasir -> QRIS barcode langsung muncul di bot
- Webhook Pakasir -> saldo masuk otomatis
- Systemd -> bot on 24 jam (auto restart)

---

## ✅ 1x Klik Install (1 Perintah)

Login VPS sebagai root lalu jalankan **satu baris** ini:

```bash
bash -c 'set -e; apt update -y; apt install -y git; rm -rf /opt/opal-zivpn-bot; git clone https://github.com/USERNAME/REPO.git /opt/opal-zivpn-bot; bash /opt/opal-zivpn-bot/install.sh'
