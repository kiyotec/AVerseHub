"""Validate a Hubcap ZIP and stage the files consumed by UnlockCore."""
import json
import re
import stat
import struct
import sys
import zlib
from pathlib import Path
from zipfile import BadZipFile, ZipFile

LIMIT = 64 * 1024 * 1024
NUMBER = r"[1-9][0-9]{0,19}"
MANIFEST = re.compile(rf"({NUMBER})_({NUMBER})\.manifest", re.I)
ADD = re.compile(rf'addappid\(\s*({NUMBER})\s*(?:,\s*[0-9]+\s*(?:,\s*(["\'])([0-9a-f]{{64}})\2\s*)?)?\)', re.I)
SET = re.compile(rf'setmanifestid\(\s*({NUMBER})\s*,\s*(?:"({NUMBER})"|({NUMBER}))(?:\s*,\s*[0-9]+)?\s*\)', re.I)
TOKEN = re.compile(rf'addtoken\(\s*({NUMBER})\s*,\s*(?:"({NUMBER})"|({NUMBER}))\s*\)', re.I)


def manifest_identity(data):
    sections = {}
    pos, magic = 0, 0
    while pos + 4 <= len(data):
        magic, = struct.unpack_from("<I", data, pos)
        pos += 4
        if magic == 0x32c415ab:
            break
        if magic not in (0x71f617d0, 0x1f4812be, 0x1b81b817) or magic in sections:
            raise ValueError("Invalid depot manifest section")
        size, = struct.unpack_from("<I", data, pos)
        pos += 4
        if size > len(data) - pos:
            raise ValueError("Truncated depot manifest section")
        sections[magic] = (pos, size)
        pos += size
    if pos != len(data) or len(sections) != 3 or magic != 0x32c415ab:
        raise ValueError("Incomplete depot manifest")
    start, size = sections[0x1f4812be]
    meta = data[start:start + size]
    if len(meta) > 65536:
        raise ValueError("Depot manifest metadata exceeds limit")
    pos = 0
    fields = {}

    def varint():
        nonlocal pos
        result = 0
        for shift in range(0, 70, 7):
            byte = meta[pos]
            pos += 1
            if shift == 63 and byte > 1:
                raise ValueError("Manifest integer overflow")
            result |= (byte & 127) << shift
            if byte < 128:
                return result
        raise ValueError("Invalid manifest integer")

    while pos < len(meta):
        tag = varint()
        field, wire = tag >> 3, tag & 7
        if wire == 0:
            if field in fields:
                raise ValueError("Duplicate manifest metadata field")
            fields[field] = varint()
        elif wire == 2:
            length = varint()
            pos += length
        elif wire in (1, 5):
            pos += 8 if wire == 1 else 4
        else:
            raise ValueError("Invalid manifest metadata type")
        if pos > len(meta):
            raise ValueError("Truncated manifest metadata")
    if not fields.get(1) or not fields.get(2):
        raise ValueError("Manifest identity is missing")
    crc = fields.get(8 if fields.get(4) else 9)
    payload, size = sections[0x71f617d0]
    if crc and zlib.crc32(memoryview(data)[payload - 4:payload + size]) != crc:
        raise ValueError("Manifest payload checksum differs")
    return fields[1], fields[2]


def stage(archive, app_id, output):
    if archive.stat().st_size > LIMIT:
        raise ValueError("ZIP exceeds size limit")
    with ZipFile(archive) as bundle:
        entries = bundle.infolist()
        if len(entries) > 256 or sum(entry.file_size for entry in entries) > LIMIT:
            raise ValueError("ZIP inventory exceeds limit")
        files = {}
        for entry in entries:
            name = entry.filename
            if name != Path(name).name or "/" in name or "\\" in name or ":" in name or name in (".", "..") or stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError("ZIP must contain regular files at its root")
            if name.lower() in files:
                raise ValueError("Duplicate ZIP filename")
            files[name.lower()] = entry

        lua_name = f"{app_id}.lua"
        if lua_name not in files or files[lua_name].file_size > 2 * 1024 * 1024:
            raise ValueError("Expected AppID Lua is missing or too large")
        lua = bundle.read(files[lua_name]).decode("utf-8-sig").replace("\r\n", "\n")
        declared = {}
        depots = {}
        tokens = {}
        lua_data = re.sub(r"--\[\[.*?\]\]|--[^\n]*", "", lua, flags=re.S)
        for line in lua_data.splitlines():
            line = line.strip().removesuffix(";").rstrip()
            if not line:
                continue
            if match := ADD.fullmatch(line):
                identifier, key = match[1], (match[3] or "").lower()
                existing = declared.get(identifier, "")
                if int(identifier) > 0xffffffff or (existing and key and existing != key):
                    raise ValueError("Invalid or conflicting app declaration")
                declared[identifier] = key or existing
            elif match := SET.fullmatch(line):
                depot, gid = match[1], match[2] or match[3]
                if int(depot) > 0xffffffff or int(gid) > 0xffffffffffffffff or depots.get(depot, gid) != gid:
                    raise ValueError("Invalid or conflicting depot mapping")
                depots[depot] = gid
            elif match := TOKEN.fullmatch(line):
                identifier, token = match[1], match[2] or match[3]
                if int(identifier) > 0xffffffff or int(token) > 0xffffffffffffffff or tokens.get(identifier, token) != token:
                    raise ValueError("Invalid or conflicting app token")
                tokens[identifier] = token
            else:
                raise ValueError("Unsupported Lua statement")
        if app_id not in declared or not depots:
            raise ValueError("Lua does not declare the requested AppID and its depots")
        manifests = {}
        for depot, gid in depots.items():
            name = f"{depot}_{gid}.manifest"
            if name not in files:
                raise ValueError(f"ZIP is missing a referenced manifest for depot {depot}")
            data = bundle.read(files[name])
            if manifest_identity(data) != (int(depot), int(gid)):
                raise ValueError(f"Manifest identity differs for depot {depot}")
            manifests[name] = data

    output.mkdir()
    ordered_apps = sorted(declared.items(), key=lambda row: int(row[0]))
    ordered_depots = sorted(depots.items(), key=lambda row: int(row[0]))
    lua_lines = [f'addappid({identifier},0,"{key}")' if key else f"addappid({identifier})" for identifier, key in ordered_apps]
    lua_lines.extend(f'addtoken({identifier},"{token}")' for identifier, token in sorted(tokens.items(), key=lambda row: int(row[0])))
    lua_lines.extend(f'setManifestid({depot},"{gid}")' for depot, gid in ordered_depots)
    (output / lua_name).write_text("\n".join(lua_lines) + "\n", encoding="utf-8", newline="\n")
    keys = ['"depots"', "{"]
    for identifier, key in ordered_apps:
        if key:
            keys.extend([f'\t"{identifier}"', "\t{", f'\t\t"DecryptionKey"\t"{key}"', "\t}"])
    (output / "key.vdf").write_text("\n".join([*keys, "}"]) + "\n", encoding="utf-8", newline="\n")
    mapping = {depot: {"manifests": {"public": {"gid": gid}}} for depot, gid in ordered_depots}
    (output / f"{app_id}.json").write_text(json.dumps({"depot": mapping}, indent=2) + "\n", encoding="utf-8", newline="\n")
    for name, data in manifests.items():
        (output / name).write_bytes(data)
    print(f"Validated AppID {app_id} and {len(manifests)} depot manifest(s)")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 4 or not re.fullmatch(NUMBER, sys.argv[2]) or int(sys.argv[2]) > 0xffffffff:
            raise ValueError("Usage: python validate-bundle.py <ZIP> <AppID> <new-directory>")
        stage(Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3]))
    except (ValueError, OSError, IndexError, struct.error, BadZipFile) as error:
        sys.exit(str(error))
