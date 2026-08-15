#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

tracked=$(git ls-files)
printf '%s\n' "$tracked" | grep -E '(^|/)(inputs|secrets|build|reports)/|\.(MOV|mov|M4A|m4a|WAV|wav)$' && {
  echo 'ERROR: Git contiene entradas, secretos, intermedios o audio sin cifrar.' >&2
  exit 1
}

if [ -f secrets/master-key.base64url ]; then
  key=$(tr -d '\r\n' < secrets/master-key.base64url)
  git grep -F -- "$key" -- . ':!scripts/check_no_secrets.sh' >/dev/null 2>&1 && {
    echo 'ERROR: la clave secreta aparece en archivos seguidos por Git.' >&2
    exit 1
  }
fi

find docs -type f \( -iname '*.mov' -o -iname '*.m4a' -o -iname '*.wav' \) -print | grep . && {
  echo 'ERROR: docs contiene audio sin cifrar.' >&2
  exit 1
}

echo 'OK: Git no contiene audio abierto, entradas, secretos ni intermedios.'
