# Opal Control Daemon (FREE/PAID)

- Bot Telegram provisioning akun (Domain/Password/Expired)
- Core: udp-zivpn (zahidbd2)
- FREE: bisa PUBLIC/PRIVATE + allowlist via command admin
- PAID: saldo + topup Pakasir + webhook + SSL
- ON 24 jam via systemd: opal-daemon

Install (repo public):
sudo bash -c 'set -e; apt update -y; apt install -y git; rm -rf /opt/opal-control-daemon; git clone https://github.com/Russel2705/opal-control-daemon.git /opt/opal-control-daemon; bash /opt/opal-control-daemon/install.sh'

Cek:
systemctl status opal-daemon
journalctl -u opal-daemon -f

Update:
sudo bash /opt/opal-control-daemon/update.sh