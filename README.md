# Opal Control Daemon (FREE/PAID)

Fitur:
- Bot Telegram provisioning akun ZiVPN (Domain/Password/Expired)
- Integrasi core udp-zivpn (zahidbd2)
- FREE: public/private + allowlist
- PAID: saldo + TopUp Pakasir + webhook + SSL
- PAID: Trial Akun (limit)
- Admin Panel: create/extend/delete akun, ban/unban, delete user, stats
- ON 24 jam via systemd (opal-daemon)

Install:
sudo bash -c 'set -e; apt update -y; apt install -y git; rm -rf /opt/opal-control-daemon; git clone https://github.com/Russel2705/opal-control-daemon.git /opt/opal-control-daemon; bash /opt/opal-control-daemon/install.sh'

Cek:
systemctl status opal-daemon
journalctl -u opal-daemon -f

Update:
sudo bash /opt/opal-control-daemon/update.sh
