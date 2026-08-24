import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { createNativeJsonSession } from './nativeProcess.mjs';

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class LuminaWindowsDurableFileOps {
  const uint GENERIC_READ = 0x80000000;
  const uint GENERIC_WRITE = 0x40000000;
  const uint DELETE = 0x00010000;
  const uint FILE_SHARE_READ = 0x1;
  const uint FILE_SHARE_WRITE = 0x2;
  const uint FILE_SHARE_DELETE = 0x4;
  const uint OPEN_EXISTING = 3;
  const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
  const uint INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF;
  const uint MOVEFILE_REPLACE_EXISTING = 0x1;
  const uint MOVEFILE_WRITE_THROUGH = 0x8;
  const int ERROR_FILE_NOT_FOUND = 2;
  const int ERROR_PATH_NOT_FOUND = 3;
  static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool FlushFileBuffers(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool ReplaceFileW(string replaced, string replacement, string backup, uint flags, IntPtr exclude, IntPtr reserved);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool MoveFileExW(string existing, string replacement, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetFileAttributesW(string path);
  [StructLayout(LayoutKind.Sequential)]
  struct FILE_DISPOSITION_INFO {
    [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct FILE_ATTRIBUTE_TAG_INFO {
    public uint FileAttributes;
    public uint ReparseTag;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetFileInformationByHandle(IntPtr handle, int fileInformationClass, ref FILE_DISPOSITION_INFO information, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandleEx(IntPtr handle, int fileInformationClass, out FILE_ATTRIBUTE_TAG_INFO information, uint size);

  static void Check(bool success, string operation) {
    if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
  }

  static string NativePath(string path) {
    if (path.StartsWith(@"\\?\")) return path;
    string absolute = Path.GetFullPath(path);
    if (absolute.StartsWith(@"\\"))
      return @"\\?\UNC\" + absolute.Substring(2);
    return @"\\?\" + absolute;
  }

  static void CheckNotReparsePoint(IntPtr handle) {
    FILE_ATTRIBUTE_TAG_INFO information;
    Check(
      GetFileInformationByHandleEx(handle, 9, out information, (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO))),
      "GetFileInformationByHandleEx(FileAttributeTagInfo)"
    );
    if ((information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
      throw new IOException("Managed durable operation opened a reparse point.");
    }
  }

  static IntPtr Open(string path, bool directory) {
    uint flags = (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0) | FILE_FLAG_OPEN_REPARSE_POINT;
    IntPtr handle = CreateFileW(NativePath(path), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      IntPtr.Zero, OPEN_EXISTING, flags, IntPtr.Zero);
    if (handle == INVALID_HANDLE_VALUE) {
      int error = Marshal.GetLastWin32Error();
      throw new Win32Exception(error, "CreateFileW error " + error);
    }
    try {
      CheckNotReparsePoint(handle);
      return handle;
    } catch {
      CloseHandle(handle);
      throw;
    }
  }

  static IntPtr OpenReadDeleteExclusive(string path) {
    IntPtr handle = CreateFileW(NativePath(path), GENERIC_READ | DELETE, 0,
      IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle == INVALID_HANDLE_VALUE) {
      int error = Marshal.GetLastWin32Error();
      throw new Win32Exception(error, "CreateFileW error " + error);
    }
    try {
      CheckNotReparsePoint(handle);
      return handle;
    } catch {
      CloseHandle(handle);
      throw;
    }
  }

  static void Flush(string path, bool directory) {
    IntPtr handle = Open(path, directory);
    try { Check(FlushFileBuffers(handle), "FlushFileBuffers"); }
    finally { CloseHandle(handle); }
  }

  public static void FlushFile(string path) { Flush(path, false); }
  public static void FlushDirectory(string path) { Flush(path, true); }

  public static bool IsReparsePoint(string path) {
    uint attributes = GetFileAttributesW(NativePath(path));
    if (attributes == INVALID_FILE_ATTRIBUTES) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "GetFileAttributesW");
    }
    return (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
  }

  public static void Replace(string temporary, string target) {
    if (ReplaceFileW(NativePath(target), NativePath(temporary), null, 0, IntPtr.Zero, IntPtr.Zero)) return;
    int error = Marshal.GetLastWin32Error();
    if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) {
      throw new Win32Exception(error, "ReplaceFileW");
    }
    Check(MoveFileExW(NativePath(temporary), NativePath(target), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH), "MoveFileExW");
  }

  static byte[] ReadLocked(string path, out FileStream stream) {
    stream = new FileStream(new SafeFileHandle(OpenReadDeleteExclusive(path), true), FileAccess.Read);
    if (stream.Length > Int32.MaxValue) throw new IOException("Durable comparison file is too large.");
    byte[] bytes = new byte[(int)stream.Length];
    int offset = 0;
    while (offset < bytes.Length) {
      int read = stream.Read(bytes, offset, bytes.Length - offset);
      if (read == 0) throw new EndOfStreamException();
      offset += read;
    }
    return bytes;
  }

  public static bool ReplaceIfCurrent(string temporary, string target, string leasePath, string expectedContents, long expiresAt) {
    if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= expiresAt) return false;
    try {
      FileStream lease;
      byte[] bytes = ReadLocked(leasePath, out lease);
      using (lease) {
        if (Encoding.UTF8.GetString(bytes) != expectedContents || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= expiresAt) return false;
        Replace(temporary, target);
        return true;
      }
    } catch (FileNotFoundException) { return false; }
  }

  public static bool RemoveIfUnchanged(string target, bool compareAsText, string expectedValue) {
    try {
      bool matches;
      FileStream file;
      byte[] bytes = ReadLocked(target, out file);
      using (file) {
        if (compareAsText) {
          matches = Encoding.UTF8.GetString(bytes) == expectedValue;
        } else {
          using (SHA256 sha = SHA256.Create()) {
            string actualSha256 = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
            matches = actualSha256 == expectedValue;
          }
        }
        if (!matches) return false;
        FILE_DISPOSITION_INFO disposition = new FILE_DISPOSITION_INFO { DeleteFile = true };
        Check(SetFileInformationByHandle(
          file.SafeFileHandle.DangerousGetHandle(),
          4,
          ref disposition,
          (uint)Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO))
        ), "SetFileInformationByHandle(FileDispositionInfo)");
      }
      return true;
    } catch (FileNotFoundException) { return false; }
  }
}
'@

while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $request = $line | ConvertFrom-Json
    switch ($request.operation) {
      'flushFile' { [LuminaWindowsDurableFileOps]::FlushFile([string]$request.target); $result = $true }
      'syncDirectory' { [LuminaWindowsDurableFileOps]::FlushDirectory([string]$request.target); $result = $true }
      'isReparsePoint' { $result = [LuminaWindowsDurableFileOps]::IsReparsePoint([string]$request.target) }
      'atomicReplace' { [LuminaWindowsDurableFileOps]::Replace([string]$request.temporary, [string]$request.target); $result = $true }
      'atomicReplaceIfLeaseCurrent' { $result = [LuminaWindowsDurableFileOps]::ReplaceIfCurrent([string]$request.temporary, [string]$request.target, [string]$request.leasePath, [string]$request.expectedContents, [Int64]$request.expiresAt) }
      'removeIfUnchanged' {
        $compareAsText = [bool]$request.compareAsText
        $expectedValue = [string]$request.expectedValue
        $result = [LuminaWindowsDurableFileOps]::RemoveIfUnchanged([string]$request.target, $compareAsText, $expectedValue)
      }
      default { throw "Unsupported durable operation $($request.operation)." }
    }
    [Console]::Out.WriteLine((@{ ok = $true; result = $result } | ConvertTo-Json -Compress))
  } catch {
    $code = if ($_.Exception.ToString().Contains('reparse point')) { 'ELOOP' } else { 'ENOTSUP' }
    [Console]::Out.WriteLine((@{ ok = $false; code = $code; message = $_.Exception.ToString() } | ConvertTo-Json -Compress))
  }
  [Console]::Out.Flush()
}
`;

export function createWindowsDurableFileOps() {
  if (process.platform !== 'win32') return null;
  const executable = path.join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!existsSync(executable)) return null;
  const command = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64'),
  ];
  const session = createNativeJsonSession(executable, command);
  const invoke = (operation, payload) => session.request({ operation, ...payload });
  return Object.freeze({
    flushFile: (target) => invoke('flushFile', { target }),
    syncDirectory: (target) => invoke('syncDirectory', { target }),
    isReparsePoint: (target) => invoke('isReparsePoint', { target }),
    atomicReplace: (temporary, target) => invoke('atomicReplace', { temporary, target }),
    atomicReplaceIfLeaseCurrent: (temporary, target, leasePath, expectedContents, expiresAt) => invoke(
      'atomicReplaceIfLeaseCurrent',
      { temporary, target, leasePath, expectedContents, expiresAt },
    ),
    removeIfUnchanged: (target, expectedContents) => invoke('removeIfUnchanged', {
      target,
      compareAsText: typeof expectedContents === 'string',
      expectedValue: typeof expectedContents === 'string' ? expectedContents : expectedContents?.sha256 ?? '',
    }),
  });
}
