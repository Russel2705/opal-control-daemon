# Opal ZiVPN Bot

Fitur:
- Pilih server (IP limit 1/2) + status penuh/tersedia
- Create akun ZiVPN (Domain/Password/Expired)
- PAID: TopUp Pakasir -> QRIS barcode langsung muncul di bot
- Webhook: saldo masuk otomatis
- systemd: bot on 24 jam

Install (1x):
1) Clone repo ke VPS:
   /opt/opal-zivpn-bot
2) Jalankan:
   sudo bash /opt/opal-zivpn-bot/install.sh

Update:
sudo bash /opt/opal-zivpn-bot/update.sh

Log:
journalctl -u opal-daemon -f
