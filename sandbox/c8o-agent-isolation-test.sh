#!/bin/sh
# Copyright (c) 2001-2026 Convertigo SA.
#
# T1 of the A4 security review (convertigo/c8oprj-tigoaccess#1): on a server with per-user Tigo keys, a confined agent
# reads nothing of another agent, of the parent-death guard or of the engine. Run it on the Linux host itself, as the
# engine's user (the No Code server's pod for test-nocode, Landlock ABI 1 there), or in a container (CI):
#
#   sh c8o-agent-isolation-test.sh HELPER [PYTHON] [ENGINE_PID]
#
# HELPER      the c8o-agent-sandbox of this machine (sandbox/linux-<arch>/c8o-agent-sandbox)
# PYTHON      a Python 3 (the managed one of the agents on a server); its install folder is given read only
# ENGINE_PID  the engine's JVM, checked too when given
#
# Two confined agents A and B run as they do in the Bridge (the system read only, /proc/self and the system-wide /proc
# files, each its own folder read-write). B and its unconfined parent (the guard's place) hold a marker in their
# environment. From A: environ, cmdline, mem, task/<pid>/environ, fd and root of B, of the guard and of the engine,
# through cat, Python open(), PTRACE_ATTACH and process_vm_readv. Every check must be refused. Nothing read is printed:
# PASS or FAIL lines only. Exit 0 when every check passed, 1 otherwise, 2 for a usage error, 3 without Landlock.
set -u

helper=${1:-}
python=${2:-}
engine=${3:-}
[ -x "$helper" ] || { echo "usage: c8o-agent-isolation-test.sh HELPER [PYTHON] [ENGINE_PID]" >&2; exit 2; }
abi=$("$helper" --probe 2>/dev/null || true)
echo "landlock abi: ${abi:-none}"
[ -n "$abi" ] && [ "$abi" -ge 1 ] || { echo "no Landlock: nothing can be confined here"; exit 3; }

work=$(mktemp -d "${TMPDIR:-/tmp}/c8o-isolation.XXXXXX")
mkdir -p "$work/a" "$work/b"
marker="c8o-isolation-marker-$$"

# the read-only system of agentSandbox() (AGENT_SANDBOX_SYSTEM_READ_ONLY in js/agent_bridge_common.js)
ro=""
for p in /bin /sbin /lib /lib32 /lib64 /usr/bin /usr/sbin /usr/lib /usr/lib32 /usr/lib64 /usr/libexec /usr/share /etc /sys /dev /proc/self /proc/thread-self /proc/cpuinfo /proc/meminfo /proc/stat /proc/loadavg /proc/uptime /proc/version /proc/filesystems /proc/sys; do ro="$ro --ro $p"; done
if [ -n "$python" ]; then
	prefix=$(cd "$(dirname "$python")/.." && pwd)
	ro="$ro --ro $prefix"
fi

# B under an unconfined parent: the guard's place in the Bridge (agentGuardedCommand)
env C8O_ISOLATION_MARKER="$marker" sh -c "\"$helper\" $ro --rw /dev/null --rw $work/b -- sleep 120; :" &
guard=$!
sleep 1
agent_b=$(ps -o pid= --ppid "$guard" 2>/dev/null | tr -d ' ' | head -n 1)
if [ -z "$agent_b" ]; then
	# without procps: the first child listed in /proc
	for d in /proc/[0-9]*; do
		if [ "$(awk '{print $4}' "$d/stat" 2>/dev/null)" = "$guard" ]; then agent_b=${d#/proc/}; break; fi
	done
fi
[ -n "$agent_b" ] || { echo "FAIL the second agent did not start"; kill "$guard" 2>/dev/null; rm -rf "$work"; exit 1; }

A="$helper $ro --rw /dev/null --rw $work/a --"
failed=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; failed=1; }

# must be refused: the command fails, or succeeds without the marker and without any byte (a /proc file of a process
# outside the domain reads empty when the kernel hides it)
refused() { # name, command...
	name=$1; shift
	if "$@" >"$work/out" 2>/dev/null; then
		if grep -q "$marker" "$work/out" 2>/dev/null || [ -s "$work/out" ]; then fail "$name"; else pass "$name (empty)"; fi
	else
		pass "$name"
	fi
	rm -f "$work/out"
}

targets="agent:$agent_b guard:$guard"
[ -n "$engine" ] && targets="$targets engine:$engine"
for target in $targets; do
	who=${target%%:*}; pid=${target#*:}
	for file in environ cmdline "task/$pid/environ"; do
		refused "cat $file of the $who" $A cat "/proc/$pid/$file"
	done
	refused "read mem of the $who" $A dd if="/proc/$pid/mem" bs=1 count=1 skip=4096
	refused "list fd of the $who" $A ls "/proc/$pid/fd"
	refused "list root of the $who" $A ls "/proc/$pid/root/"
	if [ -n "$python" ]; then
		refused "open environ of the $who (Python)" $A "$python" -I -c "import sys; print(open('/proc/$pid/environ','rb').read()[:1])"
		refused "PTRACE_ATTACH the $who" $A "$python" -I -c "
import ctypes, sys
libc = ctypes.CDLL(None, use_errno=True)
sys.exit(0 if libc.ptrace(16, $pid, 0, 0) == 0 else 1)"
		refused "process_vm_readv the $who" $A "$python" -I -c "
import ctypes, sys
libc = ctypes.CDLL(None, use_errno=True)
class iovec(ctypes.Structure):
    _fields_ = [('base', ctypes.c_void_p), ('len', ctypes.c_size_t)]
buf = ctypes.create_string_buffer(64)
local = iovec(ctypes.cast(buf, ctypes.c_void_p), 64)
remote = iovec(0x400000, 64)
n = libc.process_vm_readv($pid, ctypes.byref(local), 1, ctypes.byref(remote), 1, 0)
sys.exit(0 if n > 0 else 1)"
	fi
done
# the setup itself: an agent still reads its own entries (the command the helper runs, not a child of it: /proc/self
# is bound to the helper's pid), and an unconfined process of the same user reads the marker of B, so the refusals
# above come from the confinement
if $A cat /proc/self/cmdline >/dev/null 2>&1; then pass "control: an agent reads its own /proc/self"; else fail "control: an agent reads its own /proc/self"; fi
if grep -q "$marker" "/proc/$agent_b/environ" 2>/dev/null; then pass "control: an unconfined process reads the agent's environment"; else fail "control: an unconfined process reads the agent's environment (the test proves nothing here)"; fi

kill "$agent_b" "$guard" 2>/dev/null
rm -rf "$work"
exit $failed
