#!/bin/sh
# Identifiants de dev (montés en lecture seule, jamais affichés) puis sshd et dockerd.
set -eu
mkdir -p /var/lib/ssh-dev
[ -f /var/lib/ssh-dev/ssh_host_ed25519_key ] || ssh-keygen -q -t ed25519 -N '' -f /var/lib/ssh-dev/ssh_host_ed25519_key
echo "deploy:$(cat /run/ssh-dev/password)" | chpasswd >/dev/null 2>&1
install -o deploy -g docker -m 600 /run/ssh-dev/id_ed25519.pub /home/deploy/.ssh/authorized_keys
# AC du réseau (proxy d'entreprise, AC interne : .data/ca/*.pem) : nécessaires pour tirer les images.
for ca in /run/ssh-dev/ca/*.pem; do
  [ -s "$ca" ] && cp "$ca" "/usr/local/share/ca-certificates/$(basename "$ca" .pem).crt"
done
update-ca-certificates >/dev/null 2>&1 || true
/usr/sbin/sshd -e
# Socket Docker accessible au groupe docker (utilisateur deploy).
exec dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock --group docker
