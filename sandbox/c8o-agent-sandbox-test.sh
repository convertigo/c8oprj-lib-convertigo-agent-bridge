#!/bin/sh
# Copyright (c) 2001-2026 Convertigo SA.
#
# Checks a built c8o-agent-sandbox on a Linux kernel: runs the checks below in a throwaway ubuntu:noble container, as
# a user with the passwordless sudo the Convertigo image gives its 'convertigo' user. The CI runs it after each build:
#
#   sandbox/c8o-agent-sandbox-test.sh sandbox/linux-amd64/c8o-agent-sandbox
#
# A kernel without Landlock cannot confine: the checks are skipped with a warning (exit 0), the helper refusing to run.
set -eu

helper=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
[ -x "$helper" ] || { echo "not an executable helper: $1" >&2; exit 2; }

docker run --rm -i -v "$helper:/usr/local/bin/c8o-agent-sandbox:ro" ubuntu:noble sh -s <<'CHECKS'
set -u
abi=$(c8o-agent-sandbox --probe || true)
echo "landlock abi: ${abi:-none}"
if [ -z "$abi" ] || [ "$abi" -lt 1 ]; then
	echo "::warning::this kernel has no Landlock: the confinement checks are skipped"
	c8o-agent-sandbox --ro /etc -- true && { echo "FAIL ran a command unconfined"; exit 1; }
	echo "PASS refuses to run unconfined"
	exit 0
fi
apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends sudo >/dev/null
useradd -m agent
echo "agent ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/agent
chmod 0440 /etc/sudoers.d/agent
mkdir -p /work/ro /work/rw /work/other /usr/local/engine
echo hello > /work/ro/file
echo secret > /work/other/secret
echo engine > /usr/local/engine/file
chown -R agent:agent /work /usr/local/engine

cat > /home/agent/checks.sh <<'AGENT'
failed=0
check() { # name, expected exit (0 or "fail"), command...
	name=$1; expected=$2; shift 2
	if "$@" >/tmp/out 2>&1; then got=0; else got=fail; fi
	if [ "$got" = "$expected" ]; then echo "PASS $name"; else echo "FAIL $name ($(head -c 200 /tmp/out))"; failed=1; fi
}
# the read-only system of agentSandbox() (AGENT_SANDBOX_SYSTEM_READ_ONLY in js/agent_bridge_common.js)
S="c8o-agent-sandbox"
for p in /bin /sbin /lib /lib32 /lib64 /usr/bin /usr/sbin /usr/lib /usr/lib32 /usr/lib64 /usr/libexec /usr/share /etc /sys /dev /proc/self /proc/thread-self /proc/cpuinfo /proc/meminfo /proc/stat /proc/loadavg /proc/uptime /proc/version /proc/filesystems /proc/sys; do S="$S --ro $p"; done
S="$S --rw /dev/null --ro /work/ro --rw /work/rw --ro /does/not/exist"

check "probe" 0 c8o-agent-sandbox --probe
check "reads a read-only folder" 0 $S -- cat /work/ro/file
check "writes a read-write folder" 0 $S -- sh -c 'echo x > /work/rw/f && cat /work/rw/f && rm /work/rw/f'
check "writes /dev/null" 0 $S -- sh -c 'echo x > /dev/null'
check "does not write a read-only folder" fail $S -- sh -c 'echo x > /work/ro/g'
check "does not read another folder" fail $S -- cat /work/other/secret
check "does not list another folder" fail $S -- ls /work/other
check "a child does not read it either" fail $S -- sh -c 'sh -c "cat /work/other/secret"'
check "does not read /usr/local (Tomcat, the engine)" fail $S -- cat /usr/local/engine/file
check "sudo works outside" 0 sudo -n true
check "sudo does not work inside (no_new_privs)" fail $S -- sudo -n true
sleep 30 & outside=$!
check "reads its own /proc entries" 0 $S -- cat /proc/self/environ
check "reads the system-wide /proc files" 0 $S -- cat /proc/cpuinfo /proc/meminfo
check "does not read the environment of a process outside" fail $S -- cat /proc/$outside/environ
check "does not read the command line of a process outside" fail $S -- cat /proc/$outside/cmdline
check "does not list the processes" fail $S -- ls /proc
kill $outside
check "no command" fail c8o-agent-sandbox --ro /etc --
check "a relative path" fail c8o-agent-sandbox --ro etc -- true
check "an unknown option" fail c8o-agent-sandbox --net -- true
check "a missing command" fail $S -- /nonexistent
exit $failed
AGENT
chown agent /home/agent/checks.sh
su agent -s /bin/sh -c 'sh /home/agent/checks.sh'
CHECKS
