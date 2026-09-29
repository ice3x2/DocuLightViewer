"""Windows-only PG-09 direct I/O probe. Emits path-free JSON evidence."""
import ctypes
import hashlib
import json
import os
import sys
from ctypes import wintypes

if sys.platform != "win32":
    print(json.dumps({"status": "unsupported", "reason": "windows_required"}))
    sys.exit(1)

k = ctypes.WinDLL("kernel32", use_last_error=True)
INVALID = ctypes.c_void_p(-1).value
GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
CREATE_ALWAYS = 2
OPEN_EXISTING = 3
FILE_FLAG_NO_BUFFERING = 0x20000000
FILE_FLAG_WRITE_THROUGH = 0x80000000
MEM_COMMIT = 0x1000
MEM_RESERVE = 0x2000
MEM_RELEASE = 0x8000

k.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                          ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
k.CreateFileW.restype = wintypes.HANDLE
k.VirtualAlloc.argtypes = [ctypes.c_void_p, ctypes.c_size_t, wintypes.DWORD, wintypes.DWORD]
k.VirtualAlloc.restype = ctypes.c_void_p
k.VirtualFree.argtypes = [ctypes.c_void_p, ctypes.c_size_t, wintypes.DWORD]
k.VirtualFree.restype = wintypes.BOOL
k.WriteFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                        ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
k.WriteFile.restype = wintypes.BOOL
k.ReadFile.argtypes = k.WriteFile.argtypes
k.ReadFile.restype = wintypes.BOOL
k.CloseHandle.argtypes = [wintypes.HANDLE]
k.CloseHandle.restype = wintypes.BOOL
k.GetDiskFreeSpaceW.argtypes = [wintypes.LPCWSTR] + [ctypes.POINTER(wintypes.DWORD)] * 4
k.GetDiskFreeSpaceW.restype = wintypes.BOOL
k.GetDriveTypeW.argtypes = [wintypes.LPCWSTR]
k.GetDriveTypeW.restype = wintypes.UINT
k.GetVolumeInformationW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD,
    ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD),
    ctypes.POINTER(wintypes.DWORD), wintypes.LPWSTR, wintypes.DWORD]
k.GetVolumeInformationW.restype = wintypes.BOOL

def checked(ok, operation):
    if not ok:
        raise OSError(ctypes.get_last_error(), operation)

def volume(path):
    drive = os.path.splitdrive(os.path.abspath(path))[0]
    if not drive:
        raise ValueError("missing_local_volume")
    root = drive + "\\"
    if k.GetDriveTypeW(root) != 3:
        raise ValueError("fixed_local_volume_required")
    sectors = wintypes.DWORD()
    sector_bytes = wintypes.DWORD()
    free_clusters = wintypes.DWORD()
    total_clusters = wintypes.DWORD()
    checked(k.GetDiskFreeSpaceW(root, ctypes.byref(sectors), ctypes.byref(sector_bytes),
        ctypes.byref(free_clusters), ctypes.byref(total_clusters)), "GetDiskFreeSpaceW")
    serial = wintypes.DWORD()
    max_component = wintypes.DWORD()
    flags = wintypes.DWORD()
    fs_name = ctypes.create_unicode_buffer(64)
    checked(k.GetVolumeInformationW(root, None, 0, ctypes.byref(serial),
        ctypes.byref(max_component), ctypes.byref(flags), fs_name, 64), "GetVolumeInformationW")
    if fs_name.value.upper() != "NTFS":
        raise ValueError("ntfs_required")
    return root, serial.value, sector_bytes.value, fs_name.value

def main():
    fixture_root = os.path.abspath(sys.argv[1])
    profile = os.path.abspath(sys.argv[2])
    source = os.path.join(fixture_root, "pg09-source.bin")
    output = os.path.join(fixture_root, "pg09-output.bin")
    roots = [volume(p) for p in (source, output, profile)]
    if len({(r[0].lower(), r[1]) for r in roots}) != 1:
        raise ValueError("same_volume_required")
    sector = roots[0][2]
    size = max(4096, sector)
    size = ((size + sector - 1) // sector) * sector
    blocks = 16384  # 64 MiB at 4 KiB, fixed-size real disk traffic.
    address = k.VirtualAlloc(None, size, MEM_COMMIT | MEM_RESERVE, 0x04)
    checked(address, "VirtualAlloc")
    read_address = k.VirtualAlloc(None, size, MEM_COMMIT | MEM_RESERVE, 0x04)
    checked(read_address, "VirtualAlloc read")
    pattern = bytes((i * 17 + 29) & 255 for i in range(size))
    ctypes.memmove(address, pattern, size)
    source_hash = hashlib.sha256()
    read_hash = hashlib.sha256()
    handles = []
    try:
        for file_path in (source, output):
            h = k.CreateFileW(file_path, GENERIC_WRITE, 0, None, CREATE_ALWAYS,
                              FILE_FLAG_NO_BUFFERING | FILE_FLAG_WRITE_THROUGH, None)
            checked(h != INVALID, "CreateFileW direct write")
            handles.append(h)
            count = wintypes.DWORD()
            for index in range(blocks):
                checked(k.WriteFile(h, address, size, ctypes.byref(count), None), "WriteFile direct")
                checked(count.value == size, "short direct write")
                if file_path == source and index == 0:
                    print(json.dumps({"phase": "direct_io_started"}), flush=True)
                if file_path == source:
                    source_hash.update(pattern)
            k.CloseHandle(h)
            handles.pop()
        h = k.CreateFileW(output, GENERIC_READ, 0, None, OPEN_EXISTING,
                          FILE_FLAG_NO_BUFFERING, None)
        checked(h != INVALID, "CreateFileW direct read")
        handles.append(h)
        count = wintypes.DWORD()
        for _ in range(blocks):
            checked(k.ReadFile(h, read_address, size, ctypes.byref(count), None), "ReadFile direct")
            checked(count.value == size, "short direct read")
            read_hash.update(ctypes.string_at(read_address, size))
        expected = source_hash.hexdigest()
        checked(read_hash.hexdigest() == expected, "direct read checksum")
        print(json.dumps({"phase": "direct_io_finished"}), flush=True)
        token = hashlib.sha256(f"{roots[0][0].lower()}:{roots[0][1]}".encode()).hexdigest()[:24]
        return {"status": "pass", "semantics": "FILE_FLAG_NO_BUFFERING",
                "sourceVolumeToken": token, "outputVolumeToken": token,
                "profileVolumeToken": token, "filesystem": roots[0][3],
                "sectorBytes": sector, "bufferAligned": address % sector == 0 and read_address % sector == 0,
                "offsetsAligned": True, "fixtureBytes": blocks * size,
                "bytesRead": blocks * size, "bytesWritten": blocks * size * 2,
                "fixtureSha256": expected, "outputSha256": read_hash.hexdigest()}
    finally:
        for h in handles:
            k.CloseHandle(h)
        k.VirtualFree(address, 0, MEM_RELEASE)
        k.VirtualFree(read_address, 0, MEM_RELEASE)

if __name__ == "__main__":
    try:
        result = main()
    except (OSError, ValueError, IndexError) as error:
        result = {"status": "unsupported", "reason": str(error).split(":", 1)[0]}
    print(json.dumps(result, sort_keys=True))
    sys.exit(0 if result["status"] == "pass" else 1)
