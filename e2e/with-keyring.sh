#!/bin/sh
# Lance une commande avec un trousseau Secret Service (gnome-keyring) déverrouillé, dans une
# session D-Bus dédiée : dbus-run-session -- e2e/with-keyring.sh npm run test:e2e
eval "$(printf 'e2e' | gnome-keyring-daemon --unlock --components=secrets 2>/dev/null)"
export GNOME_KEYRING_CONTROL
exec "$@"
