import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { gzipSync } from 'node:zlib';

import { createNativeJsonSession } from './nativeProcess.mjs';

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
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
  const int ERROR_ALREADY_EXISTS = 183;
  const int ERROR_DIR_NOT_EMPTY = 145;
  static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);
  sealed class OpenManagedFile {
    public readonly List<IntPtr> Directories;
    public readonly FileStream Stream;
    public OpenManagedFile(List<IntPtr> directories, FileStream stream) {
      Directories = directories;
      Stream = stream;
    }
  }
  static readonly Dictionary<string, OpenManagedFile> OpenManagedFiles = new Dictionary<string, OpenManagedFile>();

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
  static extern bool CreateDirectoryW(string path, IntPtr security);
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
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct FILE_RENAME_INFO {
    [MarshalAs(UnmanagedType.U1)] public bool ReplaceIfExists;
    public IntPtr RootDirectory;
    public uint FileNameLength;
    public char FileName;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_STATUS_BLOCK {
    public IntPtr Status;
    public IntPtr Information;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetFileInformationByHandle(IntPtr handle, int fileInformationClass, ref FILE_DISPOSITION_INFO information, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetFileInformationByHandle(IntPtr handle, int fileInformationClass, IntPtr information, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandleEx(IntPtr handle, int fileInformationClass, out FILE_ATTRIBUTE_TAG_INFO information, uint size);
  [DllImport("ntdll.dll")]
  static extern int NtSetInformationFile(IntPtr handle, out IO_STATUS_BLOCK statusBlock, IntPtr information, uint size, int fileInformationClass);
  [DllImport("ntdll.dll")]
  static extern uint RtlNtStatusToDosError(int status);

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

  static IntPtr OpenLockedDirectory(string path) {
    IntPtr handle = CreateFileW(NativePath(path), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
      IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle == INVALID_HANDLE_VALUE) {
      int error = Marshal.GetLastWin32Error();
      throw new Win32Exception(error, "CreateFileW directory error " + error);
    }
    try {
      CheckNotReparsePoint(handle);
      return handle;
    } catch {
      CloseHandle(handle);
      throw;
    }
  }

  static IntPtr OpenRenameDirectory(string path) {
    IntPtr handle = CreateFileW(NativePath(path), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
      IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle == INVALID_HANDLE_VALUE) {
      int error = Marshal.GetLastWin32Error();
      throw new Win32Exception(error, "CreateFileW rename directory error " + error);
    }
    try {
      CheckNotReparsePoint(handle);
      return handle;
    } catch {
      CloseHandle(handle);
      throw;
    }
  }

  static string[] RelativeSegments(string relative) {
    if (relative == null) throw new IOException("Managed path is missing.");
    if (relative.Length == 0 || relative == ".") return new string[0];
    if (Path.IsPathRooted(relative)) throw new IOException("Managed path is rooted.");
    string[] segments = relative.Split(new char[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries);
    foreach (string segment in segments) {
      if (segment == "." || segment == ".." || segment.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || segment.Contains(":")) {
        throw new IOException("Managed path segment is invalid.");
      }
    }
    return segments;
  }

  static void CloseAll(List<IntPtr> handles) {
    for (int index = handles.Count - 1; index >= 0; index--) CloseHandle(handles[index]);
  }

  static List<IntPtr> LockDirectoryChain(string root, string relative, bool create) {
    string current = Path.GetFullPath(root);
    List<IntPtr> handles = new List<IntPtr>();
    try {
      handles.Add(OpenLockedDirectory(current));
      foreach (string segment in RelativeSegments(relative)) {
        string next = Path.Combine(current, segment);
        if (create && !CreateDirectoryW(NativePath(next), IntPtr.Zero)) {
          int error = Marshal.GetLastWin32Error();
          if (error != ERROR_ALREADY_EXISTS) throw new Win32Exception(error, "CreateDirectoryW");
        }
        handles.Add(OpenLockedDirectory(next));
        current = next;
      }
      return handles;
    } catch {
      CloseAll(handles);
      throw;
    }
  }

  static List<IntPtr> LockParentDirectory(string root, string relative) {
    string[] segments = RelativeSegments(relative);
    if (segments.Length == 0) throw new IOException("Managed file path is missing.");
    string parent = String.Join("\\", segments, 0, segments.Length - 1);
    return LockDirectoryChain(root, parent, false);
  }

  static string LeafName(string relative) {
    string[] segments = RelativeSegments(relative);
    if (segments.Length == 0) throw new IOException("Managed file path is missing.");
    return segments[segments.Length - 1];
  }

  static string ParentRelative(string relative) {
    string[] segments = RelativeSegments(relative);
    if (segments.Length == 0) throw new IOException("Managed file path is missing.");
    return String.Join("\\", segments, 0, segments.Length - 1);
  }

  static string ManagedPath(string root, string relative) {
    return Path.Combine(Path.GetFullPath(root), String.Join("\\", RelativeSegments(relative)));
  }

  static IntPtr OpenReadDeleteExclusive(string path, bool directory = false) {
    IntPtr handle = CreateFileW(NativePath(path), GENERIC_READ | DELETE, 0,
      IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), IntPtr.Zero);
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

  static IntPtr OpenRenameSource(string path) {
    IntPtr handle = CreateFileW(NativePath(path), GENERIC_READ | GENERIC_WRITE | DELETE, 0,
      IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle == INVALID_HANDLE_VALUE) {
      int error = Marshal.GetLastWin32Error();
      throw new Win32Exception(error, "CreateFileW rename source error " + error);
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

  static void RenamePinnedFile(IntPtr source, IntPtr targetDirectory, string targetName) {
    byte[] name = Encoding.Unicode.GetBytes(targetName);
    int replaceOffset = (int)Marshal.OffsetOf(typeof(FILE_RENAME_INFO), "ReplaceIfExists");
    int rootOffset = (int)Marshal.OffsetOf(typeof(FILE_RENAME_INFO), "RootDirectory");
    int lengthOffset = (int)Marshal.OffsetOf(typeof(FILE_RENAME_INFO), "FileNameLength");
    int nameOffset = (int)Marshal.OffsetOf(typeof(FILE_RENAME_INFO), "FileName");
    IntPtr information = Marshal.AllocHGlobal(nameOffset + name.Length);
    try {
      for (int index = 0; index < nameOffset + name.Length; index++) Marshal.WriteByte(information, index, 0);
      Marshal.WriteByte(information, replaceOffset, 1);
      Marshal.WriteIntPtr(information, rootOffset, targetDirectory);
      Marshal.WriteInt32(information, lengthOffset, name.Length);
      Marshal.Copy(name, 0, IntPtr.Add(information, nameOffset), name.Length);
      IO_STATUS_BLOCK statusBlock;
      int status = NtSetInformationFile(source, out statusBlock, information, (uint)(nameOffset + name.Length), 10);
      if (status != 0) {
        uint error = RtlNtStatusToDosError(status);
        throw new Win32Exception((int)error, "NtSetInformationFile(FileRenameInformation) error " + error);
      }
    } finally {
      Marshal.FreeHGlobal(information);
    }
  }

  public static void EnsureDirectory(string root, string relative) {
    List<IntPtr> handles = LockDirectoryChain(root, relative, true);
    CloseAll(handles);
  }

  public static void EnsureRootDirectory(string root) {
    string full = Path.GetFullPath(root);
    string volume = Path.GetPathRoot(full);
    string relative = full.Substring(volume.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    List<IntPtr> handles = LockDirectoryChain(volume, relative, true);
    CloseAll(handles);
  }

  public static string CreateNewManagedFile(string root, string relative) {
    List<IntPtr> handles = LockDirectoryChain(root, ParentRelative(relative), true);
    try {
      string targetPath = ManagedPath(root, relative);
      FileStream target = new FileStream(NativePath(targetPath), FileMode.CreateNew, FileAccess.Write, FileShare.None);
      if (target.Length != 0) {
        target.Dispose();
        throw new IOException("Managed new file is not empty.");
      }
      string token = Guid.NewGuid().ToString("N");
      OpenManagedFiles.Add(token, new OpenManagedFile(handles, target));
      return token;
    } catch {
      CloseAll(handles);
      throw;
    }
  }

  public static int WriteManagedFile(string token, string bytesBase64) {
    OpenManagedFile opened;
    if (!OpenManagedFiles.TryGetValue(token, out opened)) throw new IOException("Managed new file handle is missing.");
    byte[] bytes = Convert.FromBase64String(bytesBase64);
    opened.Stream.Write(bytes, 0, bytes.Length);
    return bytes.Length;
  }

  public static void CloseManagedFile(string token) {
    OpenManagedFile opened;
    if (!OpenManagedFiles.TryGetValue(token, out opened)) throw new IOException("Managed new file handle is missing.");
    OpenManagedFiles.Remove(token);
    try {
      opened.Stream.Flush(true);
      opened.Stream.Dispose();
    } finally {
      CloseAll(opened.Directories);
    }
  }

  public static void ReplaceManaged(string root, string temporaryRelative, string targetRelative) {
    List<IntPtr> handles = new List<IntPtr>();
    IntPtr source = INVALID_HANDLE_VALUE;
    IntPtr targetDirectory = INVALID_HANDLE_VALUE;
    try {
      handles.AddRange(LockParentDirectory(root, temporaryRelative));
      handles.AddRange(LockParentDirectory(root, targetRelative));
      source = OpenRenameSource(ManagedPath(root, temporaryRelative));
      targetDirectory = OpenRenameDirectory(ManagedPath(root, ParentRelative(targetRelative)));
      RenamePinnedFile(source, targetDirectory, LeafName(targetRelative));
    } finally {
      if (targetDirectory != INVALID_HANDLE_VALUE) CloseHandle(targetDirectory);
      if (source != INVALID_HANDLE_VALUE) CloseHandle(source);
      CloseAll(handles);
    }
  }

  public static void CopyFileManaged(string root, string sourceRelative, string targetRelative) {
    List<IntPtr> handles = new List<IntPtr>();
    try {
      handles.AddRange(LockParentDirectory(root, sourceRelative));
      handles.AddRange(LockParentDirectory(root, targetRelative));
      string sourcePath = ManagedPath(root, sourceRelative);
      string targetPath = ManagedPath(root, targetRelative);
      using (FileStream source = new FileStream(new SafeFileHandle(OpenReadDeleteExclusive(sourcePath), true), FileAccess.Read))
      using (FileStream target = new FileStream(targetPath, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
        source.CopyTo(target);
        target.Flush(true);
      }
    } finally {
      CloseAll(handles);
    }
  }

  public static bool RemoveDirectoryManaged(string root, string relative) {
    List<IntPtr> handles = new List<IntPtr>();
    IntPtr directory = INVALID_HANDLE_VALUE;
    try {
      handles.AddRange(LockParentDirectory(root, relative));
      directory = OpenReadDeleteExclusive(ManagedPath(root, relative), true);
      FILE_DISPOSITION_INFO disposition = new FILE_DISPOSITION_INFO { DeleteFile = true };
      if (!SetFileInformationByHandle(
        directory,
        4,
        ref disposition,
        (uint)Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO))
      )) {
        int error = Marshal.GetLastWin32Error();
        if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND || error == ERROR_DIR_NOT_EMPTY) return false;
        throw new Win32Exception(error, "SetFileInformationByHandle(FileDispositionInfo)");
      }
      return true;
    } catch (FileNotFoundException) {
      return false;
    } finally {
      if (directory != INVALID_HANDLE_VALUE) CloseHandle(directory);
      CloseAll(handles);
    }
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

  public static bool ReplaceIfCurrentManaged(string root, string temporaryRelative, string targetRelative, string leaseRelative, string expectedContents, long expiresAt) {
    if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= expiresAt) return false;
    List<IntPtr> handles = new List<IntPtr>();
    try {
      handles.AddRange(LockParentDirectory(root, temporaryRelative));
      handles.AddRange(LockParentDirectory(root, targetRelative));
      handles.AddRange(LockParentDirectory(root, leaseRelative));
      FileStream lease;
      byte[] bytes = ReadLocked(ManagedPath(root, leaseRelative), out lease);
      using (lease) {
        if (Encoding.UTF8.GetString(bytes) != expectedContents || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= expiresAt) return false;
        ReplaceManaged(root, temporaryRelative, targetRelative);
        return true;
      }
    } catch (FileNotFoundException) {
      return false;
    } finally {
      CloseAll(handles);
    }
  }

  public static bool RemoveIfUnchanged(string root, string relative, bool compareAsText, string expectedValue) {
    List<IntPtr> handles = new List<IntPtr>();
    try {
      handles.AddRange(LockParentDirectory(root, relative));
      bool matches;
      FileStream file;
      byte[] bytes = ReadLocked(ManagedPath(root, relative), out file);
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
    finally { CloseAll(handles); }
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
      'ensureDirectory' { [LuminaWindowsDurableFileOps]::EnsureDirectory([string]$request.root, [string]$request.relative); $result = $true }
      'ensureRootDirectory' { [LuminaWindowsDurableFileOps]::EnsureRootDirectory([string]$request.root); $result = $true }
      'createNewManagedFileManaged' { $result = [LuminaWindowsDurableFileOps]::CreateNewManagedFile([string]$request.root, [string]$request.relative) }
      'writeManagedFileManaged' { $result = [LuminaWindowsDurableFileOps]::WriteManagedFile([string]$request.token, [string]$request.bytesBase64) }
      'closeManagedFileManaged' { [LuminaWindowsDurableFileOps]::CloseManagedFile([string]$request.token); $result = $true }
      'atomicReplace' { [LuminaWindowsDurableFileOps]::Replace([string]$request.temporary, [string]$request.target); $result = $true }
      'atomicReplaceManaged' { [LuminaWindowsDurableFileOps]::ReplaceManaged([string]$request.root, [string]$request.temporaryRelative, [string]$request.targetRelative); $result = $true }
      'atomicReplaceIfLeaseCurrent' { $result = [LuminaWindowsDurableFileOps]::ReplaceIfCurrent([string]$request.temporary, [string]$request.target, [string]$request.leasePath, [string]$request.expectedContents, [Int64]$request.expiresAt) }
      'atomicReplaceIfLeaseCurrentManaged' { $result = [LuminaWindowsDurableFileOps]::ReplaceIfCurrentManaged([string]$request.root, [string]$request.temporaryRelative, [string]$request.targetRelative, [string]$request.leaseRelative, [string]$request.expectedContents, [Int64]$request.expiresAt) }
      'copyFileManaged' { [LuminaWindowsDurableFileOps]::CopyFileManaged([string]$request.root, [string]$request.sourceRelative, [string]$request.targetRelative); $result = $true }
      'removeDirectoryManaged' { $result = [LuminaWindowsDurableFileOps]::RemoveDirectoryManaged([string]$request.root, [string]$request.relative) }
      'removeIfUnchanged' {
        $compareAsText = [bool]$request.compareAsText
        $expectedValue = [string]$request.expectedValue
        $result = [LuminaWindowsDurableFileOps]::RemoveIfUnchanged([string]$request.root, [string]$request.relative, $compareAsText, $expectedValue)
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
  const compressed = gzipSync(Buffer.from(POWERSHELL_SCRIPT, 'utf8')).toString('base64');
  const loader = [
    `$bytes=[Convert]::FromBase64String('${compressed}')`,
    '$stream=New-Object IO.MemoryStream(,$bytes)',
    '$gzip=New-Object IO.Compression.GzipStream($stream,[IO.Compression.CompressionMode]::Decompress)',
    '$reader=New-Object IO.StreamReader($gzip,[Text.Encoding]::UTF8)',
    'Invoke-Expression $reader.ReadToEnd()',
  ].join(';');
  const command = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(loader, 'utf16le').toString('base64'),
  ];
  const session = createNativeJsonSession(executable, command);
  const releases = new Map();
  const invoke = (operation, payload) => session.request({ operation, ...payload });
  const createNewManagedFileManaged = async (root, relative) => {
    const token = await invoke('createNewManagedFileManaged', { root, relative });
    releases.set(token, session.retain());
    return token;
  };
  return Object.freeze({
    flushFile: (target) => invoke('flushFile', { target }),
    syncDirectory: (target) => invoke('syncDirectory', { target }),
    isReparsePoint: (target) => invoke('isReparsePoint', { target }),
    ensureDirectory: (root, relative) => invoke('ensureDirectory', { root, relative }),
    ensureRootDirectory: (root) => invoke('ensureRootDirectory', { root }),
    createNewManagedFileManaged,
    writeManagedFileManaged: (root, token, bytes) => invoke('writeManagedFileManaged', {
      root, token, bytesBase64: Buffer.from(bytes).toString('base64'),
    }),
    closeManagedFileManaged: async (root, token) => {
      try {
        return await invoke('closeManagedFileManaged', { root, token });
      } finally {
        const release = releases.get(token);
        releases.delete(token);
        release?.();
      }
    },
    atomicReplace: (temporary, target) => invoke('atomicReplace', { temporary, target }),
    atomicReplaceManaged: (root, temporaryRelative, targetRelative) => invoke(
      'atomicReplaceManaged', { root, temporaryRelative, targetRelative },
    ),
    atomicReplaceIfLeaseCurrent: (temporary, target, leasePath, expectedContents, expiresAt) => invoke(
      'atomicReplaceIfLeaseCurrent',
      { temporary, target, leasePath, expectedContents, expiresAt },
    ),
    atomicReplaceIfLeaseCurrentManaged: (root, temporaryRelative, targetRelative, leaseRelative, expectedContents, expiresAt) => invoke(
      'atomicReplaceIfLeaseCurrentManaged', { root, temporaryRelative, targetRelative, leaseRelative, expectedContents, expiresAt },
    ),
    copyFileManaged: (root, sourceRelative, targetRelative) => invoke(
      'copyFileManaged', { root, sourceRelative, targetRelative },
    ),
    removeDirectoryManaged: (root, relative) => invoke('removeDirectoryManaged', { root, relative }),
    removeIfUnchanged: (root, relative, expectedContents) => invoke('removeIfUnchanged', {
      root,
      relative,
      compareAsText: typeof expectedContents === 'string',
      expectedValue: typeof expectedContents === 'string' ? expectedContents : expectedContents?.sha256 ?? '',
    }),
  });
}
