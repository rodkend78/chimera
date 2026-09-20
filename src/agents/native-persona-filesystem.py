"""Descriptor-confined native persona storage.

The Node provider supplies only a server-owned root and validated agent id.
Every descendant is opened relative to a held descriptor with O_NOFOLLOW.
"""
import base64
import errno
import json
import os
import re
import stat
import sys

DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
MAX_BYTES = 64 * 1024
AGENT_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
CREDENTIAL = re.compile(
    r"(?:^|\n)\s*(?:export\s+)?(?:AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)"
    r"|OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY"
    r"|(?:API_?)?(?:TOKEN|SECRET|PASSWORD)|PRIVATE_KEY)\s*[:=]\s*\S+",
    re.IGNORECASE,
)
PRIVATE_KEY = re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----")


class Rejected(Exception):
    pass


def validate_agent(agent_id):
    if not isinstance(agent_id, str) or not AGENT_ID.fullmatch(agent_id):
        raise Rejected("NATIVE_AGENT_ID_INVALID")


def validate_content(content):
    if not isinstance(content, bytes) or not content or len(content) > MAX_BYTES or b"\0" in content:
        raise Rejected("NATIVE_PERSONA_CONTENT_INVALID")
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        raise Rejected("NATIVE_PERSONA_CONTENT_INVALID")
    if text.encode("utf-8") != content or CREDENTIAL.search(text) or PRIVATE_KEY.search(text):
        raise Rejected("NATIVE_PERSONA_CONTENT_INVALID")


def open_child(parent, name, create=False):
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError:
            pass
    return os.open(name, DIR_FLAGS, dir_fd=parent)


def open_persona_dir(root, agent_id, create=False):
    agent = open_child(root, agent_id, create=create)
    try:
        persona = open_child(agent, "persona", create=create)
    finally:
        os.close(agent)
    return persona


def replace_at(parent, name, content):
    try:
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode):
            raise Rejected("NATIVE_REFERENCE_SYMLINK_BLOCKED")
    except FileNotFoundError:
        pass
    temporary = ".chimera-native-" + os.urandom(24).hex() + ".tmp"
    fd = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o600,
        dir_fd=parent,
    )
    try:
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(content)
            stream.flush()
            os.fchmod(fd, 0o600)
            os.fsync(fd)
        opened = os.fstat(fd)
        entry = os.stat(temporary, dir_fd=parent, follow_symlinks=False)
        if (opened.st_dev, opened.st_ino) != (entry.st_dev, entry.st_ino):
            raise Rejected("NATIVE_REFERENCE_SYMLINK_BLOCKED")
        os.rename(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
    finally:
        os.close(fd)
        try:
            os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass


def save(root, agent_id, content):
    validate_agent(agent_id)
    validate_content(content)
    root_fd = os.open(root, DIR_FLAGS)
    try:
        persona_fd = open_persona_dir(root_fd, agent_id, create=True)
        try:
            replace_at(persona_fd, "SOUL.md", content)
        finally:
            os.close(persona_fd)
    finally:
        os.close(root_fd)
    return {"status": "saved"}


def read_persona(root, agent_id):
    validate_agent(agent_id)
    root_fd = os.open(root, DIR_FLAGS)
    try:
        persona_fd = open_persona_dir(root_fd, agent_id, create=False)
        try:
            try:
                fd = os.open("SOUL.md", FILE_FLAGS, dir_fd=persona_fd)
            except FileNotFoundError:
                return {"status": "missing"}
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_size == 0 or info.st_size > MAX_BYTES:
                    return {"status": "excluded"}
                content = b""
                while len(content) <= MAX_BYTES:
                    chunk = os.read(fd, MAX_BYTES + 1 - len(content))
                    if not chunk:
                        break
                    content += chunk
                if len(content) > MAX_BYTES:
                    return {"status": "excluded"}
            finally:
                os.close(fd)
        finally:
            os.close(persona_fd)
    finally:
        os.close(root_fd)
    try:
        validate_content(content)
    except Rejected:
        return {"status": "excluded"}
    return {"status": "present", "content": base64.b64encode(content).decode("ascii")}


def execute(request):
    operation = request.get("operation")
    if operation == "save":
        content = base64.b64decode(request.get("content", ""), validate=True)
        return save(request["root"], request["agentId"], content)
    if operation == "read":
        return read_persona(request["root"], request["agentId"])
    raise Rejected("NATIVE_REFERENCE_OPERATION_INVALID")


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.buffer.read(2 * MAX_BYTES + 4096))
        print(json.dumps({"result": execute(request)}, ensure_ascii=True))
    except Rejected as error:
        print(json.dumps({"error": str(error)}))
    except FileNotFoundError:
        print(json.dumps({"result": {"status": "missing"}}))
    except OSError as error:
        code = "NATIVE_REFERENCE_SYMLINK_BLOCKED" if error.errno in (errno.ELOOP, errno.ENOTDIR, errno.EPERM) else "NATIVE_REFERENCE_FILESYSTEM_UNAVAILABLE"
        print(json.dumps({"error": code}))
    except Exception:
        print(json.dumps({"error": "NATIVE_REFERENCE_FILESYSTEM_UNAVAILABLE"}))
