"""POSIX descriptor-relative filesystem broker. Never reopen validated path strings.

The runtime owns the root and this script. Agent-controlled descendants are opened
one component at a time with O_NOFOLLOW; every subsequent operation uses dir_fd.
No shell, imports from the workspace, or user-supplied Python are accepted.
"""
import errno
import fnmatch
import functools
import json
import os
import secrets
import stat
import sys

LIMIT = 1024 * 1024
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC


class Rejected(Exception):
    pass


def parts(value):
    if not isinstance(value, str) or not value or len(value) > 2048 or '\x00' in value or '\\' in value:
        raise Rejected('WORKER_PATH_INVALID')
    result = value.split('/')
    if any(p in ('', '.', '..') for p in result):
        raise Rejected('WORKER_PATH_INVALID')
    return result


def parent(root, components, create=False):
    fd = os.dup(root)
    try:
        for name in components[:-1]:
            if create:
                try:
                    os.mkdir(name, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(name, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd, components[-1]
    except BaseException:
        os.close(fd)
        raise


def read_at(fd, name):
    handle = os.open(name, FILE_FLAGS, dir_fd=fd)
    try:
        info = os.fstat(handle)
        if not stat.S_ISREG(info.st_mode):
            raise Rejected('WORKER_SYMLINK_ESCAPE_BLOCKED')
        if info.st_size > LIMIT:
            raise Rejected('WORKER_FILE_TOO_LARGE')
        with os.fdopen(handle, 'rb', closefd=False) as stream:
            content = stream.read(LIMIT + 1)
        if len(content) > LIMIT:
            raise Rejected('WORKER_FILE_TOO_LARGE')
        return content
    finally:
        os.close(handle)


def replace_at(fd, name, content, preserve_mode=False):
    # Refuse an existing special file. Replacement remains safe if this entry
    # changes after stat: rename replaces the entry, never follows its target.
    mode = 0o600
    try:
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode):
            raise Rejected('WORKER_SYMLINK_ESCAPE_BLOCKED')
        if preserve_mode:
            mode = stat.S_IMODE(info.st_mode) & 0o777
    except FileNotFoundError:
        pass
    temporary = '.chimera-' + secrets.token_hex(24) + '.tmp'
    handle = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=fd)
    try:
        with os.fdopen(handle, 'wb', closefd=False) as stream:
            stream.write(content)
            stream.flush()
            os.fchmod(handle, mode)
            os.fsync(handle)
        # A workspace process could replace our temporary directory entry.
        # Do not publish that substituted entry (the write itself used our fd).
        opened = os.fstat(handle)
        entry = os.stat(temporary, dir_fd=fd, follow_symlinks=False)
        if (opened.st_dev, opened.st_ino) != (entry.st_dev, entry.st_ino):
            raise Rejected('WORKER_SYMLINK_ESCAPE_BLOCKED')
        os.rename(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
    finally:
        os.close(handle)
        try:
            os.unlink(temporary, dir_fd=fd)
        except FileNotFoundError:
            pass


def remove_at(fd, name):
    try:
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(info.st_mode):
        os.unlink(name, dir_fd=fd)
        return
    try:
        child = os.open(name, DIR_FLAGS, dir_fd=fd)
    except PermissionError:
        if os.chmod in os.supports_follow_symlinks:
            # macOS provides fchmodat(AT_SYMLINK_NOFOLLOW). The parent is
            # anchored and a swapped final symlink is never followed.
            os.chmod(name, 0o700, dir_fd=fd, follow_symlinks=False)
            child = os.open(name, DIR_FLAGS, dir_fd=fd)
        else:
            anchor = os.open(name, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            try:
                # Linux O_PATH descriptors do not support fchmod. This kernel
                # fd link names our still-open inode, never an agent path.
                os.chmod('/proc/self/fd/' + str(anchor), 0o700)
                child = os.open('.', DIR_FLAGS, dir_fd=anchor)
            finally:
                os.close(anchor)
    try:
        os.fchmod(child, 0o700)
        with os.scandir(child) as entries:
            for entry in entries:
                remove_at(child, entry.name)
    finally:
        os.close(child)
    os.rmdir(name, dir_fd=fd)


def discover(root, request):
    found = []
    scanned = 0
    reason = None
    patterns = request.get('patterns', [['**', '*']])

    def matches(path):
        segments = path.split('/')
        for pattern in patterns:
            @functools.lru_cache(None)
            def match(p, s):
                if p == len(pattern):
                    return s == len(segments)
                if pattern[p] == '**':
                    return match(p + 1, s) or (s < len(segments) and match(p, s + 1))
                return s < len(segments) and fnmatch.fnmatchcase(segments[s], pattern[p]) and match(p + 1, s + 1)
            if match(0, 0):
                return True
        return False

    def collect(path):
        nonlocal reason
        if request['operation'] == 'glob' and not matches(path):
            return
        if len(found) == 500:
            reason = 'result-limit'
        else:
            found.append(path)

    def walk(fd, prefix, depth=0):
        nonlocal scanned, reason
        if depth > 64:
            reason = 'depth-limit'
            return
        with os.scandir(fd) as entries:
            for entry in entries:
                if scanned == 10000:
                    reason = 'scan-limit'
                    return
                scanned += 1
                if entry.name.lower() == '.git' or entry.is_symlink():
                    continue
                path = prefix + '/' + entry.name
                if entry.is_dir(follow_symlinks=False):
                    child = os.open(entry.name, DIR_FLAGS, dir_fd=fd)
                    try:
                        walk(child, path, depth + 1)
                    finally:
                        os.close(child)
                elif entry.is_file(follow_symlinks=False):
                    collect(path)
                if reason:
                    return

    roots = [request['path']] if request.get('path') is not None else ['mounts', 'scratch']
    for path in roots:
        components = parts(path)
        if components[0] not in ('mounts', 'scratch'):
            raise Rejected('WORKER_READ_OUTSIDE_WORKSPACE')
        if any(p.lower() == '.git' for p in components):
            raise Rejected('WORKER_SEARCH_PROTECTED')
        fd, name = parent(root, components)
        try:
            try:
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                if request.get('path') is None:
                    continue
                raise
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, DIR_FLAGS, dir_fd=fd)
                try:
                    walk(child, path)
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode):
                scanned += 1
                collect(path)
            else:
                raise Rejected('WORKER_SYMLINK_ESCAPE_BLOCKED')
        finally:
            os.close(fd)
        if reason:
            break
    coverage = {'truncated': reason is not None, 'limitReason': reason, 'scannedEntries': scanned}
    if request['operation'] == 'glob':
        return dict(paths=sorted(found), **coverage)
    results = []
    for path in sorted(found):
        fd, name = parent(root, parts(path))
        try:
            try:
                content = read_at(fd, name)
            except Rejected as error:
                if str(error) == 'WORKER_FILE_TOO_LARGE':
                    continue
                raise
        finally:
            os.close(fd)
        if b'\0' in content:
            continue
        for index, line in enumerate(content.decode('utf-8', errors='replace').split('\n')):
            if request['pattern'] in line:
                results.append({'path': path, 'line': index + 1, 'text': line[:2048]})
                if len(results) >= 500:
                    return dict(matches=results, **dict(coverage, truncated=True, limitReason='result-limit'))
    return dict(matches=results, **coverage)


def execute(request):
    root = os.open(request['root'], DIR_FLAGS)
    try:
        operation = request['operation']
        if operation in ('glob', 'grep'):
            return discover(root, request)
        components = parts(request['path'])
        if operation == 'cleanup':
            if len(components) != 1:
                raise Rejected('WORKER_PATH_INVALID')
            remove_at(root, components[0])
            return {}
        writing = operation in ('write', 'edit', 'prepare')
        if writing:
            if components[0] != 'scratch' or len(components) < 2:
                raise Rejected('WORKER_WRITE_OUTSIDE_SCRATCH')
            if any(p.lower() == '.git' for p in components) or any(components[:len(p)] == p for p in request.get('protected', [])):
                raise Rejected('WORKER_WRITE_PROTECTED')
        elif components[0] not in ('mounts', 'scratch') or len(components) < 2:
            raise Rejected('WORKER_READ_OUTSIDE_WORKSPACE')
        fd, name = parent(root, components, create=writing)
        try:
            if operation == 'prepare':
                try:
                    os.mkdir(name, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
                os.close(os.open(name, DIR_FLAGS, dir_fd=fd))
                return {}
            if operation == 'read':
                return {'path': request['path'], 'content': read_at(fd, name).decode('utf-8', errors='replace')}
            if operation == 'edit':
                content = read_at(fd, name).decode('utf-8', errors='replace')
                first = content.find(request['oldText'])
                if first < 0 or content.find(request['oldText'], first + 1) >= 0:
                    raise Rejected('WORKER_EDIT_MATCH_NOT_UNIQUE')
                content = content.replace(request['oldText'], request['newText'], 1).encode('utf-8')
            elif operation == 'write':
                content = request['content'].encode('utf-8')
            else:
                raise Rejected('WORKER_FILESYSTEM_OPERATION_INVALID')
            if len(content) > LIMIT:
                raise Rejected('WORKER_FILE_TOO_LARGE' if operation == 'edit' else 'WORKER_CONTENT_INVALID')
            replace_at(fd, name, content, preserve_mode=operation == 'edit')
            return dict(path=request['path'], **({'bytes': len(content)} if operation == 'write' else {'replacements': 1}))
        finally:
            os.close(fd)
    finally:
        os.close(root)


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(8 * LIMIT + 1)
        if len(raw) > 8 * LIMIT:
            raise Rejected('WORKER_CONTENT_INVALID')
        print(json.dumps({'result': execute(json.loads(raw))}, ensure_ascii=True))
    except Rejected as error:
        print(json.dumps({'error': str(error)}))
    except OSError as error:
        code = 'WORKER_FILE_NOT_FOUND' if error.errno == errno.ENOENT else 'WORKER_SYMLINK_ESCAPE_BLOCKED'
        print(json.dumps({'error': code}))
    except Exception:
        print(json.dumps({'error': 'WORKER_FILESYSTEM_UNAVAILABLE'}))
