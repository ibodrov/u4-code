#!/usr/bin/env bash
set -euo pipefail
umask 077
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
exec /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/python3 -B "$script_dir/sign-apk.py" "$@"
