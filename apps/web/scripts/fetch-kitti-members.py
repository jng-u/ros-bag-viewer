#!/usr/bin/env python3
"""Fetch selected members from a remote ZIP using bounded HTTP range requests."""

from __future__ import annotations

import argparse
import binascii
import pathlib
import struct
import urllib.request
import zlib


EOCD = b"PK\x05\x06"
CENTRAL = b"PK\x01\x02"
LOCAL = b"PK\x03\x04"


def request(url: str, start: int | None = None, end: int | None = None) -> bytes:
    headers = {"User-Agent": "ros-web-viewer-kitti-demo/1"}
    if start is not None and end is not None:
        headers["Range"] = f"bytes={start}-{end}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as response:
        if start is not None and response.status != 206:
            raise RuntimeError(f"server ignored byte range {start}-{end}: HTTP {response.status}")
        return response.read()


def remote_size(url: str) -> int:
    request_headers = {"User-Agent": "ros-web-viewer-kitti-demo/1"}
    request_object = urllib.request.Request(url, method="HEAD", headers=request_headers)
    with urllib.request.urlopen(request_object, timeout=60) as response:
        return int(response.headers["Content-Length"])


def central_entries(url: str) -> dict[str, tuple[int, int, int, int, int]]:
    size = remote_size(url)
    tail_start = max(0, size - 131_072)
    tail = request(url, tail_start, size - 1)
    eocd_offset = tail.rfind(EOCD)
    if eocd_offset < 0:
        raise RuntimeError("ZIP end-of-central-directory record was not found")
    _, _, _, entry_count, total_entries, central_size, central_offset, _ = struct.unpack_from(
        "<4s4H2LH", tail, eocd_offset
    )
    if entry_count != total_entries or central_offset == 0xFFFFFFFF or central_size == 0xFFFFFFFF:
        raise RuntimeError("multi-disk and ZIP64 archives are not supported")
    central = request(url, central_offset, central_offset + central_size - 1)
    entries: dict[str, tuple[int, int, int, int, int]] = {}
    offset = 0
    while offset < len(central):
        if central[offset : offset + 4] != CENTRAL:
            raise RuntimeError("invalid ZIP central-directory record")
        fields = struct.unpack_from("<4s6H3L5H2L", central, offset)
        method, crc, compressed_size, uncompressed_size = fields[4], fields[7], fields[8], fields[9]
        name_length, extra_length, comment_length, local_offset = fields[10], fields[11], fields[12], fields[16]
        name_start = offset + 46
        name = central[name_start : name_start + name_length].decode("utf-8")
        entries[name] = (method, crc, compressed_size, uncompressed_size, local_offset)
        offset = name_start + name_length + extra_length + comment_length
    return entries


def extract_member(url: str, name: str, entry: tuple[int, int, int, int, int]) -> bytes:
    method, expected_crc, compressed_size, uncompressed_size, local_offset = entry
    local_header = request(url, local_offset, local_offset + 29)
    if local_header[:4] != LOCAL:
        raise RuntimeError(f"invalid local header for {name}")
    name_length, extra_length = struct.unpack_from("<HH", local_header, 26)
    data_start = local_offset + 30 + name_length + extra_length
    compressed = request(url, data_start, data_start + compressed_size - 1)
    if method == 0:
        data = compressed
    elif method == 8:
        data = zlib.decompress(compressed, -zlib.MAX_WBITS)
    else:
        raise RuntimeError(f"unsupported ZIP compression method {method} for {name}")
    if len(data) != uncompressed_size or (binascii.crc32(data) & 0xFFFFFFFF) != expected_crc:
        raise RuntimeError(f"size or CRC mismatch for {name}")
    return data


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("members", nargs="+")
    args = parser.parse_args()
    output_dir = pathlib.Path(args.output_dir)
    entries = central_entries(args.url)
    for name in args.members:
        if name not in entries:
            raise RuntimeError(f"ZIP member not found: {name}")
        destination = output_dir / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(extract_member(args.url, name, entries[name]))
        print(f"fetched {name} ({destination.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
