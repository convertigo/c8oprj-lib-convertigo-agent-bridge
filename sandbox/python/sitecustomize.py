# Imported by Python at startup (site imports sitecustomize from PYTHONPATH) in a vibe-acp that the Agent Bridge
# runs through the engine's Landlock helper (c8o-agent-sandbox). Landlock ABI 1 (Linux 5.13 to 5.18) refuses to move
# or link a file into another directory with EXDEV, even inside a folder the process may write; from ABI 2 the helper
# grants that right (REFER) and this fallback never runs. Vibe moves files across directories in places, first of
# all its plugin store, which publishes each file from plugins/tmp into plugins/blobs and each package into
# plugins/packages: a user's first confined Vibe died there. On EXDEV, os.rename and os.replace copy the source into
# the target's directory and rename it there, then remove the source, as mv does.
import errno
import os
import shutil
import sys

_rename = os.rename
_replace = os.replace


def _remove(path):
    if os.path.isdir(path) and not os.path.islink(path):
        def writable_again(function, failed, _error):
            # a read-only folder keeps its entries: open it, then try again
            os.chmod(os.path.dirname(failed), 0o700)
            function(failed)
        if sys.version_info >= (3, 12):
            shutil.rmtree(path, onexc=writable_again)
        else:
            shutil.rmtree(path, onerror=writable_again)
    else:
        os.unlink(path)


def _copy_into_place(move, source, target):
    folder = os.path.dirname(os.path.abspath(target))
    staged = os.path.join(folder, ".c8o-move-%d-%s" % (os.getpid(), os.urandom(6).hex()))
    if os.path.isdir(source) and not os.path.islink(source):
        shutil.copytree(source, staged, symlinks=True)
    else:
        shutil.copy2(source, staged, follow_symlinks=False)
    try:
        move(staged, target)
    except BaseException:
        _remove(staged)
        raise
    _remove(source)


def _falling_back(move):
    def moved(src, dst, *, src_dir_fd=None, dst_dir_fd=None):
        try:
            return move(src, dst, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)
        except OSError as error:
            if error.errno != errno.EXDEV or src_dir_fd is not None or dst_dir_fd is not None:
                raise
        _copy_into_place(move, os.fspath(src), os.fspath(dst))
    moved.__name__ = move.__name__
    moved.__doc__ = move.__doc__
    return moved


def _run_hidden_sitecustomize():
    # Python imports one sitecustomize: the one this module hides, if the Python has one, still runs.
    import importlib.machinery
    import importlib.util
    here = os.path.dirname(os.path.abspath(__file__))
    path = [entry for entry in sys.path if os.path.abspath(entry or os.curdir) != here]
    spec = importlib.machinery.PathFinder.find_spec("sitecustomize", path)
    if spec is not None and spec.loader is not None:
        spec.loader.exec_module(importlib.util.module_from_spec(spec))


os.rename = _falling_back(_rename)
os.replace = _falling_back(_replace)
_run_hidden_sitecustomize()
