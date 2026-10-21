#!/bin/sh
# Serveurs SSH de test pour e2e/ssh.test.mjs (CI Linux, root) : un compte jetable, un sshd
# par mot de passe (port 2223) et un sshd mot de passe + code TOTP via PAM (port 2224).
# À n'utiliser que sur une machine jetable : crée un compte et lance des serveurs SSH.
set -eu

USER_NAME=mdtest
PASSWORD=Secret-123
TOTP_SECRET=JBSWY3DPEHPK3PXP
DIR=$(mktemp -d)

id "$USER_NAME" >/dev/null 2>&1 || useradd -m -s /bin/sh "$USER_NAME"
echo "$USER_NAME:$PASSWORD" | chpasswd
printf '%s\n" TOTP_AUTH\n' "$TOTP_SECRET" > "/home/$USER_NAME/.google_authenticator"
chown "$USER_NAME:" "/home/$USER_NAME/.google_authenticator"
chmod 400 "/home/$USER_NAME/.google_authenticator"

# sshd nomme son service PAM d'après son exécutable : une copie dédiée isole la configuration 2FA.
cp --remove-destination /usr/sbin/sshd /usr/sbin/sshd-md2fa
cat > /etc/pam.d/sshd-md2fa <<'EOF'
auth required pam_unix.so
auth required pam_google_authenticator.so
account required pam_unix.so
session required pam_unix.so
EOF

[ -f /etc/ssh/ssh_host_ed25519_key ] || ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key
mkdir -p /run/sshd

common="ListenAddress 127.0.0.1
HostKey /etc/ssh/ssh_host_ed25519_key
PubkeyAuthentication no
AllowUsers $USER_NAME"

printf 'Port 2223\nPidFile %s/pw.pid\nUsePAM no\nPasswordAuthentication yes\nKbdInteractiveAuthentication no\n%s\n' "$DIR" "$common" > "$DIR/pw.conf"
printf 'Port 2224\nPidFile %s/2fa.pid\nUsePAM yes\nPasswordAuthentication no\nKbdInteractiveAuthentication yes\nAuthenticationMethods keyboard-interactive\n%s\n' "$DIR" "$common" > "$DIR/2fa.conf"

/usr/sbin/sshd -f "$DIR/pw.conf" -E "$DIR/pw.log"
/usr/sbin/sshd-md2fa -f "$DIR/2fa.conf" -E "$DIR/2fa.log"
echo "sshd de test : 127.0.0.1:2223 (mot de passe), 127.0.0.1:2224 (mot de passe + TOTP), journaux dans $DIR"
