#!/bin/sh
# Host <-> component communication over a bind-mounted runtime root, using
# channels only. Uses this checkout's built asys-runtime image; the package source is
# mounted read-only so the container runs the checked-out channel code.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
package=$(cd "$here/../.." && pwd)
root=${1:-$(mktemp -d "${TMPDIR:-/tmp}/asys-host-channel.XXXXXX")}
mkdir -p "$root"
image=$(PYTHONPATH="$package" python3 -c 'from asys_runtime import release; print(release.image("asys-runtime")[0])')
echo "root: $root"
python3 "$here/host.py" "$root" demo &
host=$!
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$root:/var/lib/asys-runtime" \
  -v "$package:/opt/asys/asys-runtime:ro" \
  --entrypoint node "$image" /opt/asys/asys-runtime/examples/host-channel/component.mjs demo
wait "$host"
echo
echo "channel directory afterwards:"
find "$root/channels" -type f | sort
echo
echo "in/000000001.json:"
cat "$root/channels/demo/in/000000001.json"
